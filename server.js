// server.js
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const cookieParser = require('cookie-parser');
const path = require('path');
const turf = require('@turf/turf'); 
const mongoose = require('mongoose');
const geolib = require('geolib'); 
const axios = require('axios'); 
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000; 
const server = http.createServer(app);
const io = socketio(server);

// =================================================================
// 0. データベース接続とMongooseスキーマ定義
// =================================================================

// ★注意: ここはダミーのURIです。実際の環境変数に置き換えてください。
const MONGO_URI = process.env.ENV_MONGO_URI || "mongodb+srv://ktyoshitu87_db_user:3137admin@cluster0.ag8sryr.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
if (!MONGO_URI) {
    console.error("FATAL ERROR: MONGO_URI environment variable is not set.");
    process.exit(1);
}

async function connectDB() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("Connected to MongoDB using Mongoose.");
    } catch (err) {
        console.error("FATAL ERROR: MongoDB connection failed:", err.message);
        process.exit(1);
    }
}

// --- Mongoose Schemas ---

const GlobalStatsSchema = new mongoose.Schema({
    _id: { type: Number, default: 1 },
    gameTime: { type: Date, default: Date.now },
    timeScale: { type: Number, default: 60 },
    nextStationId: { type: Number, default: 1 },
    nextLineId: { type: Number, default: 1 },
    nextVehicleId: { type: Number, default: 1 },
}, { collection: 'global_stats' });
const GlobalStatsModel = mongoose.model('GlobalStats', GlobalStatsSchema);

const UserSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    money: { type: Number, default: 5000000000 },
    totalConstructionCost: { type: Number, default: 0 },
    lineColorIndex: { type: Number, default: 0 }, // ★追加: 路線色固定用
}, { collection: 'users' });
const UserModel = mongoose.model('User', UserSchema);

const StationSchema = new mongoose.Schema({
    id: { type: Number, required: true, unique: true },
    ownerId: { type: String, required: true },
    lat: Number,
    lng: Number,
    name: String, 
    demand: { 
        passenger: Number,
        freight: Number
    },
    lineConnections: [Number],
    type: { type: String, enum: ['Small', 'Medium', 'Large'], default: 'Small' },
    capacity: { type: Number, default: 3 }, 
}, { collection: 'stations' });
const StationModel = mongoose.model('Station', StationSchema);

const LineSchema = new mongoose.Schema({
    id: { type: Number, required: true, unique: true },
    ownerId: { type: String, required: true },
    coords: [[Number]],
    cost: Number,
    lengthKm: Number,
    color: String,
    trackType: String,
}, { collection: 'lines' });
const LineModel = mongoose.model('Line', LineSchema);

const VehicleSchema = new mongoose.Schema({
    id: { type: Number, required: true, unique: true },
    lineId: Number,
    ownerId: String,
    dataKey: String,
    positionKm: Number,
    status: String,
    isReversed: Boolean,
    stopTimer: Number,
    currentLat: Number,
    currentLng: Number,
}, { collection: 'vehicles' });
const VehicleModel = mongoose.model('Vehicle', VehicleSchema);

// ★追加: 収益ログスキーマ
const RevenueLogSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    type: { type: String, enum: ['revenue', 'maintenance', 'news'], required: true },
    amount: { type: Number, default: 0 },
    message: String,
    timestamp: { type: Date, default: Date.now },
}, { collection: 'revenue_logs' });
const RevenueLogModel = mongoose.model('RevenueLog', RevenueLogSchema);


// =================================================================
// A. サーバーサイド・ゲーム定数とユーティリティ
// =================================================================
const STATION_COST = 50000000;
const VEHICLE_BASE_COST = 8000000;
const LINE_COLORS = ['#E4007F', '#009933', '#0000FF', '#FFCC00', '#FF6600', '#9900CC', '#00FFFF', '#FF00FF', '#C0C0C0', '#800000']; // ★修正: 色を10色に増やす
const VehicleData = {
    COMMUTER: { name: "通勤形", maxSpeedKmH: 100, capacity: 500, maintenanceCostPerKm: 400, type: 'passenger', color: '#008000', purchaseMultiplier: 1.0 },
    EXPRESS: { name: "優等形", maxSpeedKmH: 160, capacity: 600, maintenanceCostPerKm: 700, type: 'passenger', color: '#FF0000', purchaseMultiplier: 1.5 },
    SHINKANSEN: { name: "新幹線", maxSpeedKmH: 300, capacity: 1000, maintenanceCostPerKm: 1500, type: 'passenger', color: '#00BFFF', purchaseMultiplier: 5.0 },
    LINEAR: { name: "リニア", maxSpeedKmH: 500, capacity: 800, maintenanceCostPerKm: 3000, type: 'passenger', color: '#FF00FF', purchaseMultiplier: 10.0 },
    LOCAL_FREIGHT: { name: "地方貨物", maxSpeedKmH: 75, capacity: 1500, maintenanceCostPerKm: 300, type: 'freight', color: '#8B4513', purchaseMultiplier: 1.2 },
    HIGH_SPEED_FREIGHT: { name: "高速貨物", maxSpeedKmH: 120, capacity: 1000, maintenanceCostPerKm: 500, type: 'freight', color: '#A0522D', purchaseMultiplier: 2.0 },
    SLEEPER: { name: "寝台列車", maxSpeedKmH: 110, capacity: 200, maintenanceCostPerKm: 800, type: 'passenger', color: '#4B0082', purchaseMultiplier: 3.0, revenueMultiplier: 2.0 }, 
    TRAM: { name: "路面電車", maxSpeedKmH: 50, capacity: 150, maintenanceCostPerKm: 100, type: 'passenger', color: '#808080', purchaseMultiplier: 0.5 }, 
};

// ★修正: Nominatim APIからの地名取得関数 (変更なし、再掲)
async function getAddressFromCoords(lat, lng) {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=ja&zoom=16`;
    try {
        const response = await axios.get(url, {
            headers: { "User-Agent": "RailwayTycoonGameServer/1.0 (Contact: your-email@example.com)" } 
        });
        
        const data = response.data;
        
        if (data.address) {
            const address = data.address;
            
            if (address.neighbourhood) return address.neighbourhood;
            if (address.suburb) return address.suburb;
            if (address.city_district) return address.city_district;
            if (address.town) return address.town;
            if (address.village) return address.village;
            
            if (address.city) return address.city;
            if (address.county) return address.county;
            
            return data.display_name.split(',')[0].trim();
        }
        return null;
    } catch (error) {
        console.error("Error fetching address from Nominatim:", error.message);
        return getAddressFromCoordsFallback(lat, lng); 
    }
}

// ★追加: Nominatim失敗時のフォールバック用（geolib + 静的データセット）(変更なし、再掲)
const JAPAN_LANDMARKS = [
    { name: "東京", lat: 35.681236, lng: 139.767125 },
    { name: "大阪", lat: 34.702485, lng: 135.495952 },
    { name: "名古屋", lat: 35.170915, lng: 136.881537 },
    { name: "博多", lat: 33.590355, lng: 130.420658 },
    { name: "札幌", lat: 43.068611, lng: 141.350833 },
    { name: "横浜", lat: 35.465833, lng: 139.622778 },
    { name: "仙台", lat: 38.260000, lng: 140.870000 },
    { name: "広島", lat: 34.396389, lng: 132.459444 },
    { name: "京都", lat: 35.001111, lng: 135.768333 },
    { name: "神戸", lat: 34.690000, lng: 135.195556 },
    { name: "千葉", lat: 35.604722, lng: 140.123333 },
    { name: "大宮", lat: 35.906944, lng: 139.623056 },
    { name: "新宿", lat: 35.689722, lng: 139.700556 },
    { name: "渋谷", lat: 35.658056, lng: 139.701667 },
    { name: "池袋", lat: 35.729722, lng: 139.710833 },
    { name: "天王寺", lat: 34.646944, lng: 135.508611 },
    { name: "新大阪", lat: 34.733333, lng: 135.500000 },
    { name: "豊洲", lat: 35.657778, lng: 139.794444 },
    { name: "お台場", lat: 35.626111, lng: 139.779722 },
    { name: "羽田", lat: 35.549444, lng: 139.779722 },
    { name: "三鷹", lat: 35.698333, lng: 139.558333 },
    { name: "立川", lat: 35.701944, lng: 139.413333 },
    { name: "八王子", lat: 35.658333, lng: 139.338333 },
    { name: "浦和", lat: 35.868333, lng: 139.658333 },
    { name: "船橋", lat: 35.696389, lng: 139.986389 },
    { name: "川崎", lat: 35.530556, lng: 139.702222 },
    { name: "熱海", lat: 35.101389, lng: 139.076944 },
    { name: "静岡", lat: 34.972222, lng: 138.384444 },
    { name: "浜松", lat: 34.708333, lng: 137.733333 },
    { name: "金沢", lat: 36.577778, lng: 136.648333 },
    { name: "新潟", lat: 37.916667, lng: 139.049444 },
    { name: "岡山", lat: 34.661667, lng: 133.918333 },
    { name: "高松", lat: 34.340278, lng: 134.046944 },
    { name: "松山", lat: 33.841667, lng: 132.766667 },
    { name: "長崎", lat: 32.750000, lng: 129.873056 },
    { name: "熊本", lat: 32.789167, lng: 130.741667 },
    { name: "那覇", lat: 26.216667, lng: 127.683333 },
];

function getAddressFromCoordsFallback(lat, lng) {
    const targetCoord = { latitude: lat, longitude: lng };
    
    const nearest = geolib.findNearest(targetCoord, JAPAN_LANDMARKS.map(item => ({
        latitude: item.lat,
        longitude: item.lng,
        name: item.name
    })));
    
    if (nearest) {
        const originalIndex = parseInt(nearest.key, 10);
        return JAPAN_LANDMARKS[originalIndex].name;
    }
    
    return null;
}

// ★修正: 駅名生成ロジック (変更なし、再掲)
async function generateRegionalStationName(lat, lng) {
    const regionalName = await getAddressFromCoords(lat, lng);
    
    if (regionalName) {
        let baseName = regionalName.replace(/通り|公園|広場|交差点|ビル|マンション|アパート|[一二三四五六七八九十]丁目|番地|日本|Japan/g, '').trim();
        
        if (baseName.endsWith("駅")) {
            return baseName;
        }
        
        if (baseName.length > 10) {
            baseName = baseName.substring(0, 10);
        }
        
        return `${baseName}駅`;
    }
    
    const randomAreas = ["新興", "郊外", "住宅", "公園", "中央", "東", "西", "南", "北"];
    const randomSuffixes = ["台", "丘", "本", "前", "野", "ヶ原"];
    const area = randomAreas[Math.floor(Math.random() * randomAreas.length)];
    const suffix = randomSuffixes[Math.floor(Math.random() * randomSuffixes.length)];
    
    return `${area}${suffix}駅`;
}

function getElevation(lat, lng) {
    const TOKYO_BAY_LAT = 35.6;
    const TOKYO_BAY_LNG = 139.7;
    const tokyoDist = Math.sqrt((lat - TOKYO_BAY_LAT) ** 2 + (lng - TOKYO_BAY_LNG) ** 2);
    let elevation = 100 * Math.exp(-tokyoDist * 5) + (Math.random() * 5); 
    if (lng < 139.7) { elevation += 10 + (139.7 - lng) * 50; }
    if (lat < 35.6) { elevation += 10 + (35.6 - lat) * 50; }
    return Math.round(Math.min(3000, Math.max(0, elevation)));
}
function getDistanceKm(coord1, coord2) {
    const lngLat1 = [coord1[1], coord1[0]];
    const lngLat2 = [coord2[1], coord2[0]];
    return turf.distance(turf.point(lngLat1), turf.point(lngLat2), {units: 'kilometers'});
}
// ★修正: 建設コスト計算ロジックを強化 (高低差コストの明確化)
function calculateConstructionCost(coord1, coord2, trackType) {
    const distanceKm = getDistanceKm(coord1, coord2);
    if (distanceKm === 0) return { cost: 0, lengthKm: 0 };
    const lengthM = distanceKm * 1000;
    const elev1 = getElevation(coord1[0], coord1[1]);
    const elev2 = getElevation(coord2[0], coord2[1]);
    const elevationDiff = Math.abs(elev1 - elev2);
    
    // 1. ベースコスト (1kmあたり2.5M)
    let baseCost = distanceKm * 2500000;
    
    // 2. 線路タイプ乗数
    if (trackType === 'double') baseCost *= 1.8;
    else if (trackType === 'linear') baseCost *= 5.0; 
    else if (trackType === 'tram') baseCost *= 0.8; 
    
    // 3. 勾配コスト (高低差が大きいほどコスト増)
    const slope = elevationDiff / lengthM;
    let slopeMultiplier = 1;
    if (slope > 0.03) slopeMultiplier = 1 + Math.pow(slope * 10, 2); 
    const slopeCost = (slopeMultiplier - 1) * baseCost;
    
    // 4. 高所コスト (標高が高いほどコスト増)
    const avgElevation = (elev1 + elev2) / 2;
    const highElevationCost = Math.max(0, avgElevation - 100) * 5000 * distanceKm; // 100m超からコスト発生
    
    const totalCost = baseCost + slopeCost + highElevationCost;
    
    return { 
        cost: Math.round(totalCost), 
        lengthKm: distanceKm,
        baseCost: Math.round(baseCost),
        slopeCost: Math.round(slopeCost),
        highElevationCost: Math.round(highElevationCost)
    };
}
// =================================================================
// B. サーバーサイド・クラス定義
// =================================================================
class ServerStation {
    constructor(id, latlng, ownerId, type = 'Small', initialName = null, demand = null) {
        this.id = id;
        this.latlng = latlng;
        this.ownerId = ownerId;
        this.name = initialName || `仮駅名 ${id}`; 
        this.demand = demand || { 
            passenger: Math.round(50 + Math.random() * 300),
            freight: Math.round(10 + Math.random() * 100)
        };
        this.lineConnections = []; 
        this.type = type; 
        this.capacity = this.getCapacityByType(type); 
        this.occupyingVehicles = new Set(); 
    }
    
    getCapacityByType(type) {
        switch (type) {
            case 'Medium': return 5;
            case 'Large': return 10;
            case 'Small':
            default: return 3;
        }
    }
    
    addLine(lineId) {
        if (!this.lineConnections.includes(lineId)) {
            this.lineConnections.push(lineId);
        }
    }
    get lat() { return this.latlng[0]; }
    get lng() { return this.latlng[1]; }
}
class ServerVehicle {
    constructor(id, line, data, status = 'Running') { // ★修正: 初期ステータスを受け取る
        this.id = id;
        this.lineId = line ? line.id : null; // ★修正: lineがnullの場合を考慮
        this.ownerId = line ? line.ownerId : null;
        this.data = data;
        this.coords = line ? line.coords : [];
        this.stations = line ? line.stations : []; 
        
        this.positionKm = 0; 
        this.status = status; 
        this.isReversed = false; 
        this.stopTimer = 0; 
        this.currentLat = this.coords.length > 0 ? this.coords[0][0] : 0;
        this.currentLng = this.coords.length > 0 ? this.coords[0][1] : 0;
        this.waitingForStationKm = -1; 

        this.totalRouteKm = [0];
        if (this.coords.length > 1) {
            for(let i = 1; i < this.coords.length; i++) {
                const segmentKm = getDistanceKm(this.coords[i-1], this.coords[i]);
                this.totalRouteKm.push(this.totalRouteKm[i-1] + segmentKm);
            }
        }
        this.routeLength = this.totalRouteKm[this.totalRouteKm.length - 1] || 0;
        
        this.crowdFactor = 0; // ★追加: 混雑度 (0.0 to 1.0)
    }

    getStationKm(station) {
        // ... (省略: getStationKmロジックは変更なし)
        const COORD_TOLERANCE = 0.000001; 
        for(let i = 0; i < this.coords.length; i++) {
            if (Math.abs(this.coords[i][0] - station.latlng[0]) < COORD_TOLERANCE && 
                Math.abs(this.coords[i][1] - station.latlng[1]) < COORD_TOLERANCE) {
                return this.totalRouteKm[i];
            }
        }
        return -1; 
    }

    move(gameDeltaSeconds) {
        if (this.status === 'Idle') return; // ★追加: 待機状態の場合は移動しない
        
        if (this.status === 'Stopping') {
            this.stopTimer -= gameDeltaSeconds;
            if (this.stopTimer <= 0) {
                const currentStation = this.stations.find(s => this.getStationKm(s) === this.positionKm);
                if (currentStation) {
                    currentStation.occupyingVehicles.delete(this.id);
                }
                this.status = 'Running';
            }
            return;
        }
        
        if (this.status === 'Waiting') {
            const nextStation = this.stations.find(s => this.getStationKm(s) === this.waitingForStationKm);
            if (nextStation && nextStation.occupyingVehicles.size < nextStation.capacity) {
                this.status = 'Running';
                this.waitingForStationKm = -1;
            } else {
                return; 
            }
        }

        if (this.status !== 'Running') return;
        
        // ... (省略: 衝突回避ロジックは変更なし)

        const speedKms = this.data.maxSpeedKmH / 3600; 
        const travelDistanceKm = speedKms * gameDeltaSeconds; 
        
        const direction = this.isReversed ? -1 : 1;
        this.positionKm += travelDistanceKm * direction;

        if (this.positionKm >= this.routeLength) {
            this.positionKm = this.routeLength;
            this.isReversed = true;
            this.handleStationArrival(this.stations[this.stations.length-1]);
            return;
        } else if (this.positionKm <= 0) {
            this.positionKm = 0;
            this.isReversed = false;
            this.handleStationArrival(this.stations[0]);
            return;
        }

        this.updateCoordinates();
        this.checkStationArrival();
    }
    
    updateCoordinates() {
        // ... (省略: updateCoordinatesロジックは変更なし)
        let targetKm = this.positionKm;
        
        let idx = this.totalRouteKm.findIndex(km => km > targetKm);
        if (idx === -1) idx = this.coords.length - 1; 
        
        let startKm = this.totalRouteKm[idx - 1] || 0;
        let endKm = this.totalRouteKm[idx];
        let segmentLength = endKm - startKm;
        if (segmentLength === 0) return; 
        let progress = (targetKm - startKm) / segmentLength;
        let prevCoord = this.coords[idx - 1];
        let nextCoord = this.coords[idx];
        this.currentLat = prevCoord[0] * (1 - progress) + nextCoord[0] * progress;
        this.currentLng = prevCoord[1] * (1 - progress) + nextCoord[1] * progress;
    }

    checkStationArrival() {
        // ... (省略: checkStationArrivalロジックは変更なし)
        const arrivalTolerance = 0.05; 
        
        let closestNextStation = null;
        let minDistance = Infinity;
        
        this.stations.forEach(station => {
            const stationKm = this.getStationKm(station);
            if (stationKm === -1) return;
            
            const distance = this.isReversed ? this.positionKm - stationKm : stationKm - this.positionKm;
            
            if (distance > 0 && distance < minDistance) {
                closestNextStation = station;
                minDistance = distance;
            }
        });
        
        if (closestNextStation && minDistance < arrivalTolerance && this.status === 'Running') {
            const stationKm = this.getStationKm(closestNextStation);
            this.positionKm = stationKm; 
            this.handleStationArrival(closestNextStation);
        }
    }
    
    // ★修正: 収益計算ロジックの強化（混雑度、収益ログ）
    async handleStationArrival(station) {
        station.occupyingVehicles.add(this.id);
        
        this.status = 'Stopping';
        this.stopTimer = 30; 
        let revenue = 0;
        const revenueMultiplier = this.data.revenueMultiplier || 1.0;
        
        // 1. 混雑度計算
        let demandValue = 0;
        let capacityValue = 0;
        if (this.data.type === 'passenger') {
            demandValue = station.demand.passenger;
            capacityValue = this.data.capacity;
        } else if (this.data.type === 'freight') {
            demandValue = station.demand.freight;
            capacityValue = this.data.capacity;
        }
        
        this.crowdFactor = Math.min(1.0, demandValue / capacityValue);
        
        // 2. ベース収益計算
        if (this.data.type === 'passenger') {
            revenue = demandValue * 5000 * revenueMultiplier * (1 + this.crowdFactor * 0.5); // 混雑度が高いほど収益増
        } else if (this.data.type === 'freight') {
            revenue = demandValue * 2000 * revenueMultiplier * (1 + this.crowdFactor * 0.3);
        }
        
        // 3. 接続ボーナス
        const stationsAtLocation = ServerGame.globalStats.stations.filter(s => 
            s.latlng[0] === station.latlng[0] && s.latlng[1] === station.latlng[1]
        );
        const totalConnections = stationsAtLocation.flatMap(s => s.lineConnections).length;
        revenue *= (1 + Math.min(1.0, totalConnections * 0.1)); 
        
        revenue = Math.round(revenue);
        
        
    }
}
class ServerLineManager {
    // ... (省略: ServerLineManagerロジックは変更なし)
    constructor(id, ownerId, stations, coords, cost, lengthKm, color, trackType) {
        this.id = id;
        this.ownerId = ownerId;
        this.stations = stations;
        this.coords = coords; 
        this.cost = cost;
        this.lengthKm = lengthKm;
        this.color = color;
        this.trackType = trackType;
        this.vehicles = [];
    }
    async addVehicle(vehicleKey) {
        const data = VehicleData[vehicleKey];
        const purchaseCost = VEHICLE_BASE_COST * data.purchaseMultiplier;
        const user = ServerGame.users[this.ownerId];
        if (!user || user.money < purchaseCost) {
            return { success: false, message: '資金不足' };
        }
        
        const isLinear = data.name === 'リニア';
        
        if (isLinear && this.trackType !== 'linear') {
             return { success: false, message: 'リニアは専用線路が必要です' };
        }
        if (!isLinear && this.trackType === 'linear') {
             return { success: false, message: 'リニア線路にはリニア以外配置できません' };
        }
        
        user.money -= purchaseCost;
        
        const vehicleId = ServerGame.globalStats.nextVehicleId++;
        await saveGlobalStats();
        
        const newVehicle = new ServerVehicle(vehicleId, this, data); 
        this.vehicles.push(newVehicle);
        user.vehicles.push(newVehicle);
        
        const dataKey = Object.keys(VehicleData).find(key => VehicleData[key] === newVehicle.data);
        await VehicleModel.create({
            id: newVehicle.id,
            lineId: newVehicle.lineId,
            ownerId: newVehicle.ownerId,
            dataKey: dataKey,
            positionKm: newVehicle.positionKm,
            status: newVehicle.status,
            isReversed: newVehicle.isReversed, 
            stopTimer: newVehicle.stopTimer,
            currentLat: newVehicle.currentLat,
            currentLng: newVehicle.currentLng
        });
        
        await saveUserFinancials(user.userId, user.money, user.totalConstructionCost);
        
        return { success: true, vehicle: newVehicle };
    }
    runSimulation(gameDeltaSeconds) {
        this.vehicles.filter(v => v.status !== 'Idle').forEach(v => v.move(gameDeltaSeconds)); // ★修正: Idle車両は動かさない
    }
}
// =================================================================
// C. サーバーサイド・ゲーム状態管理 (メモリ内キャッシュ)
// =================================================================
const ServerGame = {
    users: {}, 
    globalStats: {
        gameTime: new Date(2025, 0, 1, 0, 0, 0),
        timeScale: 60, 
        stations: [], 
        allLines: [], 
        lastMonthlyMaintenance: 0,
        nextStationId: 1,
        nextLineId: 1,
        nextVehicleId: 1,
        lastNewsTime: new Date(), // ★追加: ニュース生成用
    },
    VehicleData: VehicleData,
};
// =================================================================
// C-1. DB操作関数 (Mongoose)
// =================================================================
async function saveGlobalStats() {
    // ... (省略: saveGlobalStatsロジックは変更なし)
    const stats = ServerGame.globalStats;
    await GlobalStatsModel.updateOne({ _id: 1 }, {
        $set: {
            gameTime: stats.gameTime,
            timeScale: stats.timeScale,
            nextStationId: stats.nextStationId,
            nextLineId: stats.nextLineId,
            nextVehicleId: stats.nextVehicleId,
        }
    }, { upsert: true }); 
}

async function saveUserFinancials(userId, money, totalConstructionCost) {
    // ... (省略: saveUserFinancialsロジックは変更なし)
    await UserModel.updateOne({ userId: userId }, {
        $set: {
            money: money,
            totalConstructionCost: totalConstructionCost
        }
    });
}

async function loadUserData(userId) {
    const userRow = await UserModel.findOne({ userId: userId }).lean();
    if (!userRow) return null;

    const user = {
        socketId: null,
        userId: userRow.userId,
        money: userRow.money,
        totalConstructionCost: userRow.totalConstructionCost,
        establishedLines: [],
        vehicles: [],
        moneyUpdated: false, 
        lineColorIndex: userRow.lineColorIndex || 0, // ★追加: 色インデックス
    };

    const linesRes = await LineModel.find({ ownerId: userId }).lean();
    const lineManagers = linesRes.map(row => {
        const coords = row.coords; 
        const lineStations = coords.map(coord => 
            ServerGame.globalStats.stations.find(s => s.latlng[0] === coord[0] && s.latlng[1] === coord[1])
        ).filter(s => s);
        
        const line = new ServerLineManager(
            row.id, row.ownerId, lineStations, coords, 
            row.cost, row.lengthKm, row.color, row.trackType
        );
        return line;
    });
    user.establishedLines = lineManagers;

    const vehiclesRes = await VehicleModel.find({ ownerId: userId }).lean();
    vehiclesRes.forEach(row => {
        const line = user.establishedLines.find(l => l.id === row.lineId);
        const data = VehicleData[row.dataKey];
        
        const vehicle = new ServerVehicle(row.id, line || { id: row.lineId, ownerId: row.ownerId, coords: [], stations: [] }, data, row.status); // ★修正: lineがない場合もVehicleを作成
        
        vehicle.lineId = row.lineId; // ★修正: lineIdを再設定
        vehicle.positionKm = row.positionKm;
        vehicle.status = row.status;
        vehicle.isReversed = row.isReversed;
        vehicle.stopTimer = row.stopTimer;
        vehicle.currentLat = row.currentLat;
        vehicle.currentLng = row.currentLng;
        
        if (line) {
            line.vehicles.push(vehicle);
        }
        user.vehicles.push(vehicle);
    });
    return user;
}

// ★修正: 駅名リネーム関数 (変更なし、再掲)
async function renameStation(userId, stationId, newName) {
    // ... (省略: renameStationロジックは変更なし)
    const user = ServerGame.users[userId];
    if (!user) return { success: false, message: "ユーザーが見つかりません。" };
    
    const globalStation = ServerGame.globalStats.stations.find(s => s.id === stationId && s.ownerId === userId);
    if (!globalStation) return { success: false, message: "あなたの駅が見つかりません。" };
    
    if (newName.length < 2 || newName.length > 20) {
        return { success: false, message: "駅名は2文字以上20文字以内で入力してください。" };
    }
    
    const oldName = globalStation.name;
    globalStation.name = newName;

    await StationModel.updateOne(
        { id: stationId },
        { $set: { name: newName } }
    );
    
    return { 
        success: true, 
        oldName: oldName,
        newName: newName,
        message: `${oldName} を ${newName} にリネームしました。`
    };
}


// =================================================================
// C-2. ゲームロジック関数
// =================================================================
async function calculateMonthlyMaintenance() {
    let totalCost = 0;
    
    for (const user of Object.values(ServerGame.users)) {
        let monthlyMaintenance = 0;
        
        user.establishedLines.forEach(line => {
            monthlyMaintenance += line.cost * 0.002; 
        });
        
        user.vehicles.forEach(vehicle => {
            monthlyMaintenance += vehicle.data.maintenanceCostPerKm * 1000; 
        });
        
        const userCost = Math.round(monthlyMaintenance);
        user.money -= userCost;
        totalCost += userCost;
        
        await saveUserFinancials(user.userId, user.money, user.totalConstructionCost);
        
        // ★追加: 維持費ログを記録
        await RevenueLogModel.create({
            userId: user.userId,
            type: 'maintenance',
            amount: -userCost,
            message: `月次維持費の支払い`,
        });
        
        if (user.socketId) {
            io.to(user.socketId).emit('revenueLog', {
                type: 'maintenance',
                amount: -userCost,
                message: `月次維持費の支払い`,
            });
        }
    }
    ServerGame.globalStats.lastMonthlyMaintenance = totalCost;
}

async function calculateRanking() {
    // ... (省略: calculateRankingロジックは変更なし)
    const allUsers = await UserModel.find({}).lean();
    
    const rankingPromises = allUsers.map(async (user) => {
        const totalConstructionCost = user.totalConstructionCost;
        const vehicleCount = await VehicleModel.countDocuments({ ownerId: user.userId, status: { $ne: 'Idle' } }); // 待機車両はカウントしない
        
        const score = user.money + totalConstructionCost * 0.7 + vehicleCount * 10000000;
        
        return {
            userId: user.userId,
            score: score,
        };
    });
    
    const ranking = await Promise.all(rankingPromises);
    
    return ranking
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
}

// ★追加: 車両売却ロジック
async function sellVehicle(userId, vehicleId) {
    const user = ServerGame.users[userId];
    if (!user) return { success: false, message: "ユーザーが見つかりません。" };
    
    const vehicleIndex = user.vehicles.findIndex(v => v.id === vehicleId);
    if (vehicleIndex === -1) return { success: false, message: "あなたの車両が見つかりません。" };
    
    const vehicleToSell = user.vehicles[vehicleIndex];
    const data = vehicleToSell.data;
    const salePrice = Math.round(VEHICLE_BASE_COST * data.purchaseMultiplier * 0.5); // 購入価格の50%
    
    user.money += salePrice;
    user.vehicles.splice(vehicleIndex, 1);
    
    await VehicleModel.deleteOne({ id: vehicleId });
    await saveUserFinancials(user.userId, user.money, user.totalConstructionCost);
    
    // ラインマネージャーからも削除
    if (vehicleToSell.lineId) {
        const line = user.establishedLines.find(l => l.id === vehicleToSell.lineId);
        if (line) {
            line.vehicles = line.vehicles.filter(v => v.id !== vehicleId);
        }
    }
    
    return { 
        success: true, 
        message: `車両 #${vehicleId} (${data.name}) を売却し、¥${salePrice.toLocaleString()}を獲得しました。`,
        vehicleId: vehicleId
    };
}

// ★追加: 車両の路線からの撤去ロジック
async function removeVehicleFromLine(userId, vehicleId) {
    const user = ServerGame.users[userId];
    if (!user) return { success: false, message: "ユーザーが見つかりません。" };
    
    const vehicle = user.vehicles.find(v => v.id === vehicleId);
    if (!vehicle) return { success: false, message: "あなたの車両が見つかりません。" };
    
    if (vehicle.status === 'Idle') return { success: false, message: "車両は既に待機状態です。" };
    
    vehicle.status = 'Idle';
    vehicle.lineId = null;
    
    await VehicleModel.updateOne(
        { id: vehicleId },
        { $set: { status: 'Idle', lineId: null } }
    );
    
    // ラインマネージャーからも削除
    const line = user.establishedLines.find(l => l.vehicles.some(v => v.id === vehicleId));
    if (line) {
        line.vehicles = line.vehicles.filter(v => v.id !== vehicleId);
    }
    
    return { 
        success: true, 
        message: `車両 #${vehicleId} (${vehicle.data.name}) を路線から撤去し、待機状態にしました。`,
        vehicleId: vehicleId
    };
}

// ★追加: 駅の需要変動ロジック
function updateStationDemand() {
    const newsMessages = [];
    
    ServerGame.globalStats.stations.forEach(station => {
        // ベース変動 (±10%)
        station.demand.passenger = Math.max(50, station.demand.passenger * (1 + (Math.random() - 0.5) * 0.2));
        station.demand.freight = Math.max(10, station.demand.freight * (1 + (Math.random() - 0.5) * 0.2));
        
        // ランダムイベント (5%の確率で発生)
        if (Math.random() < 0.05) {
            const factor = 1.5 + Math.random(); // 1.5倍から2.5倍
            if (Math.random() < 0.5) {
                // 旅客需要急増
                station.demand.passenger *= factor;
                newsMessages.push(`${station.name} 周辺で大規模イベントが発生！旅客需要が急増！`);
            } else {
                // 貨物需要急増
                station.demand.freight *= factor;
                newsMessages.push(`${station.name} 周辺に新工場が建設！貨物需要が急増！`);
            }
        }
        
        station.demand.passenger = Math.round(station.demand.passenger);
        station.demand.freight = Math.round(station.demand.freight);
    });
    
    // ニュースをブロードキャスト
    if (newsMessages.length > 0) {
        const news = { message: newsMessages[Math.floor(Math.random() * newsMessages.length)] };
        io.emit('gameNews', news);
    }
    
    // DBに需要を保存
    const updatePromises = ServerGame.globalStats.stations.map(s => 
        StationModel.updateOne({ id: s.id }, { $set: { demand: s.demand } })
    );
    Promise.all(updatePromises);
}


async function dismantleLine(userId, lineId) {
    // ... (省略: dismantleLineロジックは変更なし)
    const user = ServerGame.users[userId];
    if (!user) return { success: false, message: "ユーザーが見つかりません。" };
    const lineIndex = user.establishedLines.findIndex(l => l.id === lineId);
    if (lineIndex === -1) return { success: false, message: "路線が見つかりません。" };
    const lineToDismantle = user.establishedLines[lineIndex];
    
    const dismantleCost = Math.round(lineToDismantle.cost * 0.1);
    if (user.money < dismantleCost) return { success: false, message: "解体費用が不足しています。" };
    user.money -= dismantleCost;
    
    let totalVehicleSaleRevenue = 0;
    
    const vehiclesOnLine = user.vehicles.filter(v => v.lineId === lineId);
    
    // ★修正: 車両を売却するロジックを統合
    const vehicleSalePromises = vehiclesOnLine.map(async v => {
        const data = v.data;
        const purchaseCost = VEHICLE_BASE_COST * data.purchaseMultiplier;
        const saleRevenue = Math.round(purchaseCost / 3); // 路線解体時は1/3で売却
        user.money += saleRevenue;
        totalVehicleSaleRevenue += saleRevenue;
        await VehicleModel.deleteOne({ id: v.id });
    });
    await Promise.all(vehicleSalePromises);
    
    user.vehicles = user.vehicles.filter(v => v.lineId !== lineId);
    
    user.establishedLines.splice(lineIndex, 1);
    user.totalConstructionCost -= lineToDismantle.cost;
    await LineModel.deleteOne({ id: lineId });
    
    ServerGame.globalStats.allLines = ServerGame.globalStats.allLines.filter(l => l.id !== lineId);
    
    const updatePromises = [];
    for (const station of lineToDismantle.stations) {
        const globalStation = ServerGame.globalStats.stations.find(s => s.id === station.id);
        if (globalStation) {
            globalStation.lineConnections = globalStation.lineConnections.filter(id => id !== lineId);
            updatePromises.push(StationModel.updateOne(
                { id: globalStation.id },
                { $set: { lineConnections: globalStation.lineConnections } }
            ));
        }
    }
    await Promise.all(updatePromises);
    
    await saveUserFinancials(user.userId, user.money, user.totalConstructionCost);
    return { 
        success: true, 
        message: `路線 ${lineId} を解体しました。車両売却収益: ¥${totalVehicleSaleRevenue.toLocaleString()}`,
        lineId: lineId,
        dismantleCost: dismantleCost
    };
}
async function dismantleStation(userId, stationId) {
    // ... (省略: dismantleStationロジックは変更なし)
    const user = ServerGame.users[userId];
    if (!user) return { success: false, message: "ユーザーが見つかりません。" };
    const globalStationIndex = ServerGame.globalStats.stations.findIndex(s => s.id === stationId && s.ownerId === userId);
    if (globalStationIndex === -1) return { success: false, message: "あなたの駅が見つかりません。" };
    const stationToDismantle = ServerGame.globalStats.stations[globalStationIndex];
    
    if (stationToDismantle.lineConnections.length > 0) {
        return { success: false, message: "この駅には路線が接続されています。先に路線をすべて解体してください。" };
    }
    
    const dismantleCost = Math.round(STATION_COST * 0.1);
    if (user.money < dismantleCost) return { success: false, message: "解体費用が不足しています。" };
    user.money -= dismantleCost;
    
    ServerGame.globalStats.stations.splice(globalStationIndex, 1);
    await StationModel.deleteOne({ id: stationId });
    
    await saveUserFinancials(user.userId, user.money, user.totalConstructionCost);
    return { 
        success: true, 
        message: `駅 ${stationToDismantle.name} (ID: ${stationId}) を解体しました。`, 
        stationId: stationId,
        dismantleCost: dismantleCost
    };
}

async function upgradeStation(userId, stationId, newType, cost) {
    // ... (省略: upgradeStationロジックは変更なし)
    const user = ServerGame.users[userId];
    if (!user) return { success: false, message: "ユーザーが見つかりません。" };
    
    if (user.money < cost) return { success: false, message: "資金不足で駅をアップグレードできません。" };

    const globalStation = ServerGame.globalStats.stations.find(s => s.id === stationId && s.ownerId === userId);
    if (!globalStation) return { success: false, message: "あなたの駅が見つかりません。" };
    
    const newCapacity = globalStation.getCapacityByType(newType);
    
    globalStation.type = newType;
    globalStation.capacity = newCapacity;

    await StationModel.updateOne(
        { id: stationId },
        { $set: { type: newType, capacity: newCapacity } }
    );

    user.money -= cost;
    await saveUserFinancials(user.userId, user.money, user.totalConstructionCost);
    
    return { 
        success: true, 
        type: newType, 
        capacity: newCapacity,
        message: `${globalStation.name} を ${newType} 駅にアップグレードしました。`
    };
}


let lastSimTime = performance.now();
let lastDbUpdateTime = performance.now(); // ★追加: DB更新間隔制御用
async function serverSimulationLoop() { 
    const currentTime = performance.now();
    const deltaTimeMs = currentTime - lastSimTime;
    lastSimTime = currentTime;
    
    const gameDeltaSeconds = (deltaTimeMs / 1000) * ServerGame.globalStats.timeScale;
    
    const gameTime = ServerGame.globalStats.gameTime;
    const prevMonth = gameTime.getMonth();
    gameTime.setTime(gameTime.getTime() + (deltaTimeMs * ServerGame.globalStats.timeScale));
    const nowMonth = gameTime.getMonth();
    
    if (nowMonth !== prevMonth) {
        await calculateMonthlyMaintenance(); 
        await saveGlobalStats(); 
        updateStationDemand(); // ★追加: 月初に需要を変動
    }
    
    const trainPositions = [];
    const usersToUpdateFinancials = []; 
    
    Object.values(ServerGame.users).forEach(user => {
        user.establishedLines.forEach(line => {
            line.runSimulation(gameDeltaSeconds); 
        });
        
        user.vehicles.filter(v => v.status !== 'Idle').forEach(v => { // ★修正: Idle車両は除外
            trainPositions.push({
                id: v.id,
                owner: user.userId,
                latlng: [v.currentLat, v.currentLng], 
                color: v.data.color,
                status: v.status,
                crowdFactor: v.crowdFactor // ★追加: 混雑度を送信
            });
        });

        if (user.moneyUpdated) {
            usersToUpdateFinancials.push(user);
            user.moneyUpdated = false; 
        }
    });

    usersToUpdateFinancials.forEach(user => {
        if (user.socketId) {
            io.to(user.socketId).emit('updateUserState', {
                money: user.money,
                vehicles: user.vehicles.map(v => ({ id: v.id, dataKey: Object.keys(VehicleData).find(key => VehicleData[key] === v.data), lineId: v.lineId })), // ★修正: lineIdとdataKeyを送信
            });
        }
    });
    
    // ★追加: 車両位置のDB更新を最適化 (1秒に1回など)
    if (currentTime - lastDbUpdateTime > 1000) { 
        const vehicleUpdatePromises = [];
        Object.values(ServerGame.users).forEach(user => {
            user.vehicles.forEach(v => {
                vehicleUpdatePromises.push(VehicleModel.updateOne(
                    { id: v.id },
                    { $set: { 
                        positionKm: v.positionKm, 
                        status: v.status, 
                        isReversed: v.isReversed, 
                        stopTimer: v.stopTimer,
                        currentLat: v.currentLat,
                        currentLng: v.currentLng,
                        lineId: v.lineId, // Idleでnullになる可能性
                    } }
                ));
            });
        });
        await Promise.all(vehicleUpdatePromises);
        lastDbUpdateTime = currentTime;
    }

    io.emit('gameUpdate', {
        time: gameTime.toISOString(),
        trainPositions: trainPositions,
        globalStats: {
            timeScale: ServerGame.globalStats.timeScale,
            stationsCount: ServerGame.globalStats.stations.length,
            lastMonthlyMaintenance: ServerGame.globalStats.lastMonthlyMaintenance,
        },
        stations: ServerGame.globalStats.stations.map(s => ({ id: s.id, demand: s.demand })) // ★追加: 駅の需要変動をブロードキャスト
    });
    
    io.emit('rankingUpdate', await calculateRanking()); 
}
// =================================================================
// D. ExpressとSocket.IOのセットアップ
// =================================================================
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'))); 
app.post('/login', express.json(), async (req, res) => {
    const { username, password } = req.body;
    if (!username || username.length < 3 || !password) {
        return res.status(400).send({ message: "ユーザー名とパスワードを入力してください。" });
    }
    
    try {
        let userRow = await UserModel.findOne({ userId: username }).lean();
        
        if (userRow) {
            if (userRow.password !== password) {
                return res.status(401).send({ message: "パスワードが違います。" });
            }
        } else {
            // ★修正: 新規ユーザーに路線色インデックスを割り当て
            const userCount = await UserModel.countDocuments({});
            const lineColorIndex = userCount % LINE_COLORS.length;
            
            await UserModel.create({
                userId: username,
                password: password,
                money: 5000000000,
                totalConstructionCost: 0,
                lineColorIndex: lineColorIndex,
            });
            console.log(`新規ユーザー登録: ${username} (色インデックス: ${lineColorIndex})`);
        }
    } catch (e) {
        console.error("ユーザー認証/登録エラー:", e);
        return res.status(500).send({ message: "サーバー認証中にエラーが発生しました。" });
    }

    res.cookie('userId', username, { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }); 
    res.send({ success: true, userId: username });
});

io.on('connection', (socket) => {
    let userId = null;
    socket.on('login', async (data) => {
        userId = data.userId;
        if (!userId) return;
        if (!ServerGame.users[userId]) {
            const loadedUser = await loadUserData(userId); 
            if (loadedUser) {
                ServerGame.users[userId] = loadedUser;
            } else {
                return;
            }
        }
        
        const userState = ServerGame.users[userId];
        userState.socketId = socket.id; 
        
        const clientLines = userState.establishedLines.map(line => ({ 
            id: line.id, ownerId: line.ownerId, 
            coords: line.coords, color: line.color, 
            trackType: line.trackType, cost: line.cost 
        }));
        
        const allClientLines = ServerGame.globalStats.allLines;

        socket.emit('initialState', {
            money: userState.money,
            totalConstructionCost: userState.totalConstructionCost,
            establishedLines: clientLines, 
            allLines: allClientLines, 
            vehicles: userState.vehicles.map(v => ({ id: v.id, dataKey: Object.keys(VehicleData).find(key => VehicleData[key] === v.data), lineId: v.lineId })), // ★修正: dataKeyとlineIdを送信
            stations: ServerGame.globalStats.stations.map(s => ({ 
                id: s.id, latlng: [s.lat, s.lng], ownerId: s.ownerId, type: s.type, capacity: s.capacity, name: s.name, demand: s.demand 
            })), 
            vehicleData: ServerGame.VehicleData,
        });
    });
    
    socket.on('buildStation', async (data) => {
        // ... (省略: buildStationロジックは変更なし)
        if (!userId) return;
        const user = ServerGame.users[userId];
        const latlng = [data.latlng.lat, data.latlng.lng];
        
        if (user.money < STATION_COST) {
            socket.emit('error', '資金不足で駅を建設できません。');
            return;
        }
        
        try {
            const newStationPoint = turf.point([latlng[1], latlng[0]]); 
            const exclusionRadiusKm = 0.5; 
            
            for (const existingStation of ServerGame.globalStats.stations) {
                if (existingStation.ownerId === userId) continue;
                
                const existingStationPoint = turf.point([existingStation.lng, existingStation.lat]);
                const distanceKm = turf.distance(newStationPoint, existingStationPoint, { units: 'kilometers' });
                
                if (distanceKm < exclusionRadiusKm) {
                    socket.emit('error', `他のプレイヤー (${existingStation.ownerId}) の駅が ${Math.round(distanceKm * 1000)}m 以内にあります。建設できません。`);
                    return;
                }
            }

            const stationId = ServerGame.globalStats.nextStationId++;
            await saveGlobalStats();
            
            const newStationName = await generateRegionalStationName(latlng[0], latlng[1]);
            
            const newStation = new ServerStation(stationId, latlng, userId, 'Small', newStationName); 
            
            await StationModel.create({
                id: newStation.id,
                ownerId: newStation.ownerId,
                lat: latlng[0],
                lng: latlng[1],
                name: newStation.name, 
                demand: newStation.demand,
                lineConnections: newStation.lineConnections,
                type: newStation.type, 
                capacity: newStation.capacity 
            });

            user.money -= STATION_COST;
            ServerGame.globalStats.stations.push(newStation);
            
            await saveUserFinancials(user.userId, user.money, user.totalConstructionCost);
            
            io.emit('stationBuilt', { 
                latlng: data.latlng, id: newStation.id, ownerId: userId, type: newStation.type, capacity: newStation.capacity, name: newStation.name, demand: newStation.demand 
            });
            socket.emit('updateUserState', { 
                money: user.money,
                vehicles: user.vehicles.map(v => ({ id: v.id, dataKey: Object.keys(VehicleData).find(key => VehicleData[key] === v.data), lineId: v.lineId })),
            });
        } catch (error) {
            console.error("buildStation error:", error);
            socket.emit('error', '駅の建設中にエラーが発生しました。');
        }
    });
    
    socket.on('upgradeStation', async (data) => {
        // ... (省略: upgradeStationロジックは変更なし)
        if (!userId) return;
        
        const result = await upgradeStation(userId, data.stationId, data.newType, data.cost);
        
        if (result.success) {
            io.emit('stationUpgraded', { 
                id: data.stationId, 
                ownerId: userId, 
                type: result.type, 
                capacity: result.capacity 
            });
            
            const user = ServerGame.users[userId];
            socket.emit('updateUserState', { 
                money: user.money,
                vehicles: user.vehicles.map(v => ({ id: v.id, dataKey: Object.keys(VehicleData).find(key => VehicleData[key] === v.data), lineId: v.lineId })),
            });
            socket.emit('info', result.message);
        } else {
            socket.emit('error', result.message);
        }
    });
    
    socket.on('renameStation', async (data) => {
        // ... (省略: renameStationロジックは変更なし)
        if (!userId) return;
        
        const result = await renameStation(userId, data.stationId, data.newName);
        
        if (result.success) {
            io.emit('stationRenamed', { 
                id: data.stationId, 
                newName: result.newName 
            });
            socket.emit('info', result.message);
        } else {
            socket.emit('error', result.message);
        }
    });

    socket.on('buildLine', async (data) => {
        if (!userId || data.stationCoords.length < 2) return;
        
        const user = ServerGame.users[userId];
        const lineId = ServerGame.globalStats.nextLineId++;
        await saveGlobalStats(); 
        
        // ★修正: ユーザーの固定色インデックスを使用
        const lineColor = LINE_COLORS[user.lineColorIndex % LINE_COLORS.length];
        
        let totalCost = 0;
        let totalLengthKm = 0;
        
        for (let i = 1; i < data.stationCoords.length; i++) {
            const { cost: segCost, lengthKm: segLength } = calculateConstructionCost(data.stationCoords[i-1], data.stationCoords[i], data.trackType);
            totalCost += segCost;
            totalLengthKm += segLength;
        }
        if (user.money < totalCost) {
            socket.emit('error', `資金不足です！線路建設費用: ¥${totalCost.toLocaleString()}`);
            return;
        }
        try {
            user.money -= totalCost;
            user.totalConstructionCost += totalCost;
            
            // ★修正: ユーザーの路線色インデックスを更新
            user.lineColorIndex = (user.lineColorIndex + 1) % LINE_COLORS.length;
            await UserModel.updateOne({ userId: userId }, { $set: { lineColorIndex: user.lineColorIndex } });
            
            await saveUserFinancials(user.userId, user.money, user.totalConstructionCost);

            const lineStations = data.stationCoords.map(coord => 
                ServerGame.globalStats.stations.find(s => s.latlng[0] === coord[0] && s.latlng[1] === coord[1])
            ).filter(s => s);
            const newLineManager = new ServerLineManager(
                lineId, userId, lineStations, data.stationCoords, totalCost, totalLengthKm, lineColor, data.trackType
            );
            user.establishedLines.push(newLineManager);
            
            await LineModel.create({
                id: lineId,
                ownerId: userId,
                coords: data.stationCoords,
                cost: totalCost,
                lengthKm: totalLengthKm,
                color: lineColor,
                trackType: data.trackType
            });
            
            ServerGame.globalStats.allLines.push({
                id: lineId, ownerId: userId, coords: data.stationCoords, color: lineColor, trackType: data.trackType, cost: totalCost, lengthKm: totalLengthKm
            });
            
            const updatePromises = [];
            for (const station of lineStations) {
                station.addLine(lineId);
                updatePromises.push(StationModel.updateOne(
                    { id: station.id },
                    { $set: { lineConnections: station.lineConnections } }
                ));
            }
            await Promise.all(updatePromises);

            io.emit('lineBuilt', {
                ownerId: userId, id: lineId, coords: data.stationCoords, color: lineColor, 
                trackType: data.trackType, cost: totalCost, lengthKm: totalLengthKm
            });
            
            socket.emit('updateUserState', { 
                money: user.money, 
                totalConstructionCost: user.totalConstructionCost,
                establishedLines: user.establishedLines.map(line => ({ 
                    id: line.id, ownerId: line.ownerId, 
                    coords: line.coords, color: line.color, 
                    trackType: line.trackType, cost: line.cost 
                })),
                vehicles: user.vehicles.map(v => ({ id: v.id, dataKey: Object.keys(VehicleData).find(key => VehicleData[key] === v.data), lineId: v.lineId })),
            });
        } catch (error) {
            console.error("buildLine error:", error);
            socket.emit('error', '路線の建設中にエラーが発生しました。');
        }
    });
    socket.on('buyVehicle', async (data) => {
        // ... (省略: buyVehicleロジックは変更なし)
        if (!userId) return;
        
        const user = ServerGame.users[userId];
        const line = user.establishedLines.find(l => l.id == data.lineId);
        
        if (line) {
            const result = await line.addVehicle(data.vehicleKey); 
            if (result.success) {
                socket.emit('updateUserState', {
                    money: user.money,
                    vehicles: user.vehicles.map(v => ({ id: v.id, dataKey: Object.keys(VehicleData).find(key => VehicleData[key] === v.data), lineId: v.lineId })),
                });
                socket.emit('info', `車両 #${result.vehicle.id} (${result.vehicle.data.name}) を購入し、Line ${data.lineId}に割り当てました。`);
            } else {
                socket.emit('error', `車両購入失敗: ${result.message}`);
            }
        }
    });
    
    // ★追加: 車両売却ハンドラ
    socket.on('sellVehicle', async (data) => {
        if (!userId) return;
        
        const result = await sellVehicle(userId, data.vehicleId);
        
        if (result.success) {
            const user = ServerGame.users[userId];
            socket.emit('updateUserState', {
                money: user.money,
                vehicles: user.vehicles.map(v => ({ id: v.id, dataKey: Object.keys(VehicleData).find(key => VehicleData[key] === v.data), lineId: v.lineId })),
            });
            socket.emit('info', result.message);
        } else {
            socket.emit('error', result.message);
        }
    });
    
    // ★追加: 車両撤去ハンドラ
    socket.on('removeVehicleFromLine', async (data) => {
        if (!userId) return;
        
        const result = await removeVehicleFromLine(userId, data.vehicleId);
        
        if (result.success) {
            const user = ServerGame.users[userId];
            socket.emit('updateUserState', {
                money: user.money,
                vehicles: user.vehicles.map(v => ({ id: v.id, dataKey: Object.keys(VehicleData).find(key => VehicleData[key] === v.data), lineId: v.lineId })),
            });
            socket.emit('info', result.message);
        } else {
            socket.emit('error', result.message);
        }
    });
    
    socket.on('dismantleLine', async (data) => {
        // ... (省略: dismantleLineロジックは変更なし)
        if (!userId) return;
        
        const result = await dismantleLine(userId, data.lineId); 
        
        if (result.success) {
            io.emit('lineDismantled', { lineId: result.lineId, ownerId: userId });
            
            const user = ServerGame.users[userId];
            socket.emit('updateUserState', {
                money: user.money,
                totalConstructionCost: user.totalConstructionCost,
                establishedLines: user.establishedLines.map(l => ({ id: l.id, ownerId: l.ownerId, coords: l.coords, color: l.color, trackType: l.trackType, cost: l.cost })),
                vehicles: user.vehicles.map(v => ({ id: v.id, dataKey: Object.keys(VehicleData).find(key => VehicleData[key] === v.data), lineId: v.lineId })),
            });
            socket.emit('info', result.message);
        } else {
            socket.emit('error', result.message);
        }
    });
    socket.on('dismantleStation', async (data) => {
        // ... (省略: dismantleStationロジックは変更なし)
        if (!userId) return;
        
        const result = await dismantleStation(userId, data.stationId); 
        
        if (result.success) {
            io.emit('stationDismantled', { stationId: result.stationId, ownerId: userId });
            
            const user = ServerGame.users[userId];
            socket.emit('updateUserState', {
                money: user.money,
                totalConstructionCost: user.totalConstructionCost,
                vehicles: user.vehicles.map(v => ({ id: v.id, dataKey: Object.keys(VehicleData).find(key => VehicleData[key] === v.data), lineId: v.lineId })),
            });
            socket.emit('info', result.message);
        } else {
            socket.emit('error', result.message);
        }
    });
    socket.on('disconnect', () => {
        // ...
    });
});
// =================================================================
// E. サーバー起動ロジック
// =================================================================
async function initializeDatabase() {
    // ... (省略: initializeDatabaseロジックは変更なし)
    const count = await GlobalStatsModel.countDocuments({});
    if (count === 0) {
        await GlobalStatsModel.create({
            _id: 1,
            gameTime: new Date(2025, 0, 1, 0, 0, 0),
            timeScale: 60,
            nextStationId: 1,
            nextLineId: 1,
            nextVehicleId: 1
        });
    }
}
async function loadGlobalStats() {
    // ... (省略: loadGlobalStatsロジックは変更なし)
    const statsRow = await GlobalStatsModel.findById(1).lean();
    if (statsRow) {
        ServerGame.globalStats.gameTime = new Date(statsRow.gameTime);
        ServerGame.globalStats.timeScale = statsRow.timeScale;
        ServerGame.globalStats.nextStationId = statsRow.nextStationId;
        ServerGame.globalStats.nextLineId = statsRow.nextLineId;
        ServerGame.globalStats.nextVehicleId = statsRow.nextVehicleId;
    }

    const stationsRes = await StationModel.find({}).lean();
    ServerGame.globalStats.stations = stationsRes.map(row => {
        let stationName = row.name;
        if (!stationName || stationName.startsWith("駅 ") || stationName.includes("新駅") || stationName.includes("仮駅名")) { 
             stationName = row.name || `仮駅名 ${row.id}`;
        }
        
        const station = new ServerStation(row.id, [row.lat, row.lng], row.ownerId, row.type || 'Small', stationName, row.demand); // ★修正: demandを渡す
        station.lineConnections = row.lineConnections;
        station.capacity = station.getCapacityByType(station.type); 
        return station;
    });
    
    const updatePromises = ServerGame.globalStats.stations
        .filter(s => s.name.startsWith("仮駅名"))
        .map(async (station) => {
            const newName = await generateRegionalStationName(station.lat, station.lng);
            if (newName !== station.name) {
                station.name = newName;
                await StationModel.updateOne({ id: station.id }, { $set: { name: newName } });
                console.log(`既存の仮駅名 ${station.id} を ${newName} に更新しました。`);
            }
        });
    
    await Promise.all(updatePromises);


    const allLinesRes = await LineModel.find({}).lean();
    ServerGame.globalStats.allLines = allLinesRes.map(row => {
        return {
            id: row.id,
            ownerId: row.ownerId,
            coords: row.coords,
            color: row.color,
            trackType: row.trackType,
            cost: row.cost,
            lengthKm: row.lengthKm,
        };
    });
}
async function startServer() {
    try {
        await connectDB();
        await initializeDatabase();
        await loadGlobalStats();
        
        setInterval(serverSimulationLoop, 100); 
        server.listen(PORT, () => {
            console.log(`サーバーがポート ${PORT} で起動しました。`);
        });
    } catch (error) {
        console.error("サーバー起動エラー:", error);
        process.exit(1);
    }
}

startServer();
