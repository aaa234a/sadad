


// server.js
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const cookieParser = require('cookie-parser');
const path = require('path');
const turf = require('@turf/turf'); 
const mongoose = require('mongoose');
const axios = require('axios'); 
const { fromUrl } = require('geotiff');
const proj4 = require('proj4'); 
const { performance } = require('perf_hooks'); 
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000; 
const server = http.createServer(app);
const io = socketio(server);

// =================================================================
// 0. データベース接続とMongooseスキーマ定義
// =================================================================

// 環境変数 MONGO_URI は実行環境に合わせて設定してください
const MONGO_URI = process.env.ENV_MONGO_URI || "mongodb+srv://ktyoshitu87_db_user:3137admin@cluster0.ag8sryr.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
if (!MONGO_URI) {
    console.error("FATAL ERROR: MONGO_URI environment variable is not set.");
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
    // IDカウンターのフィールドは残す
    nextStationId: { type: Number, default: 1 }, 
    nextLineId: { type: Number, default: 1 },
    nextVehicleId: { type: Number, default: 1 },
}, { collection: 'global_stats' });
const GlobalStatsModel = mongoose.model('GlobalStats', GlobalStatsSchema);

const LoanSchema = new mongoose.Schema({
    amount: Number,
    remaining: Number,
    monthlyRepayment: Number,
    interestRate: Number,
    termMonths: Number,
    startMonth: Number,
    startYear: Number
});

const UserSchema = new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    money: { type: Number, default: 5000000000 },
    totalConstructionCost: { type: Number, default: 0 },
    loans: [LoanSchema], 
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

const AirportSchema = new mongoose.Schema({
    id: { type: Number, required: true, unique: true },
    ownerId: { type: String, required: true },
    lat: Number,
    lng: Number,
    name: String,
    lineConnections: [Number],
    type: { type: String, enum: ['Small', 'Medium', 'Large'], default: 'Small' },
    capacity: { type: Number, default: 5 }, 
}, { collection: 'airports' });
const AirportModel = mongoose.model('Airport', AirportSchema);

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
    formationSize: { type: Number, default: 1 }, // ★ 追加
    cargo: { 
        passenger: { type: Number, default: 0 },
        freight: { type: Number, default: 0 },
        destinationTerminalId: { type: Number, default: null }
    }
}, { collection: 'vehicles' });
const VehicleModel = mongoose.model('Vehicle', VehicleSchema);

const ChatSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    message: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
}, { collection: 'chat_messages' });
const ChatModel = mongoose.model('Chat', ChatSchema);


// =================================================================
// A. サーバーサイド・ゲーム定数とユーティリティ
// =================================================================
const STATION_COST = 50000000;
const AIRPORT_COST = 500000000;
const VEHICLE_BASE_COST = 8000000;
const AIRPLANE_BASE_COST = 50000000;
const LINE_COLORS = ['#E4007F', '#009933', '#0000FF', '#FFCC00', '#FF6600', '#9900CC'];
const MAX_LOAN_RATE = 0.5; 
const ANNUAL_INTEREST_RATE = 0.10; // ★ 10%に引き上げ

const VehicleData = {
    COMMUTER: { name: "通勤形", maxSpeedKmH: 100, capacity: 500, maintenanceCostPerKm: 400, type: 'passenger', category: 'rail', color: '#008000', purchaseMultiplier: 1.0, maxFormation: 10 }, 
    EXPRESS: { name: "優等形", maxSpeedKmH: 160, capacity: 600, maintenanceCostPerKm: 700, type: 'passenger', category: 'rail', color: '#FF0000', purchaseMultiplier: 1.5, maxFormation: 12 }, 
    SHINKANSEN: { name: "新幹線", maxSpeedKmH: 300, capacity: 1000, maintenanceCostPerKm: 1500, type: 'passenger', category: 'rail', color: '#00BFFF', purchaseMultiplier: 5.0, maxFormation: 16 }, 
    LINEAR: { name: "リニア", maxSpeedKmH: 500, capacity: 800, maintenanceCostPerKm: 3000, type: 'passenger', category: 'rail', color: '#FF00FF', purchaseMultiplier: 10.0, maxFormation: 10 }, 
    LOCAL_FREIGHT: { name: "地方貨物", maxSpeedKmH: 75, capacity: 1500, maintenanceCostPerKm: 300, type: 'freight', category: 'rail', color: '#8B4513', purchaseMultiplier: 1.2, maxFormation: 20 }, 
    HIGH_SPEED_FREIGHT: { name: "高速貨物", maxSpeedKmH: 120, capacity: 1000, maintenanceCostPerKm: 500, type: 'freight', category: 'rail', color: '#A0522D', purchaseMultiplier: 2.0, maxFormation: 15 }, 
    SLEEPER: { name: "寝台列車", maxSpeedKmH: 110, capacity: 200, maintenanceCostPerKm: 800, type: 'passenger', category: 'rail', color: '#4B0082', purchaseMultiplier: 3.0, revenueMultiplier: 2.0, maxFormation: 12 }, 
    TRAM: { name: "路面電車", maxSpeedKmH: 50, capacity: 150, maintenanceCostPerKm: 100, type: 'passenger', category: 'rail', color: '#808080', purchaseMultiplier: 0.5, maxFormation: 3 }, 
    TOURIST: { name: "観光列車", maxSpeedKmH: 80, capacity: 300, maintenanceCostPerKm: 500, type: 'passenger', category: 'rail', color: '#FFD700', purchaseMultiplier: 1.8, revenueMultiplier: 2.5, maxFormation: 8 }, 
    HEAVY_FREIGHT: { name: "重量貨物", maxSpeedKmH: 60, capacity: 3000, maintenanceCostPerKm: 450, type: 'freight', category: 'rail', color: '#696969', purchaseMultiplier: 1.5, maxFormation: 30 }, 
    INTERCITY: { name: "都市間特急", maxSpeedKmH: 200, capacity: 750, maintenanceCostPerKm: 1000, type: 'passenger', category: 'rail', color: '#FFA500', purchaseMultiplier: 3.0, maxFormation: 10 }, 
    SUBWAY: { name: "地下鉄", maxSpeedKmH: 90, capacity: 400, maintenanceCostPerKm: 350, type: 'passenger', category: 'rail', color: '#4682B4', purchaseMultiplier: 0.8, maxFormation: 8 }, 
    MIXED_CARGO: { name: "混載貨物", maxSpeedKmH: 90, capacity: 1000, maintenanceCostPerKm: 400, type: 'freight', category: 'rail', color: '#556B2F', purchaseMultiplier: 1.3, maxFormation: 18 }, 
    
    // 飛行機データ (編成は1固定とする)
    SMALL_JET: { name: "小型ジェット", maxSpeedKmH: 800, capacity: 150, maintenanceCostPerKm: 5000, type: 'passenger', category: 'air', color: '#00FFFF', purchaseMultiplier: 5.0, maxFormation: 1 },
    CARGO_PLANE: { name: "貨物機", maxSpeedKmH: 650, capacity: 50000, maintenanceCostPerKm: 4000, type: 'freight', category: 'air', color: '#808000', purchaseMultiplier: 7.0, maxFormation: 1 },
    JUMBO_JET: { name: "大型旅客機", maxSpeedKmH: 900, capacity: 500, maintenanceCostPerKm: 8000, type: 'passenger', category: 'air', color: '#FFFFFF', purchaseMultiplier: 15.0, maxFormation: 1 },
    SUPERSONIC: { name: "超音速機", maxSpeedKmH: 2000, capacity: 100, maintenanceCostPerKm: 20000, type: 'passenger', category: 'air', color: '#FF00FF', purchaseMultiplier: 50.0, maxFormation: 1 }, 
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateGreatCirclePath(coord1, coord2) {
    const start = turf.point([coord1[1], coord1[0]]);
    const end = turf.point([coord2[1], coord2[0]]);
    
    const distanceKm = turf.distance(start, end, { units: 'kilometers' });
    
    if (distanceKm < 500) { 
        return [coord1, coord2];
    }
    
    const line = turf.greatCircle(start, end);
    const lineLength = turf.length(line, { units: 'kilometers' });
    
    const intermediatePoints = [];
    intermediatePoints.push(coord1);

    const stepKm = 100;
    const numSteps = Math.floor(lineLength / stepKm);

    for (let i = 1; i <= numSteps; i++) {
        const point = turf.along(line, i * stepKm, { units: 'kilometers' });
        intermediatePoints.push([point.geometry.coordinates[1], point.geometry.coordinates[0]]);
    }
    
    if (intermediatePoints[intermediatePoints.length - 1][0] !== coord2[0] || intermediatePoints[intermediatePoints.length - 1][1] !== coord2[1]) {
        intermediatePoints.push(coord2);
    }
    
    return intermediatePoints;
}


// =================================================================
// GeoTIFF人口データ処理ロジック (簡略化のため省略)
// =================================================================
const WORLDPOP_URL = 'https://drive.usercontent.google.com/download?id=1RXhkeCoPf5gDpz7kO40wn4x4646sXNqq&export=download&authuser=0&confirm=t&uuid=ad389895-3ad2-4345-a5b8-fdfc6a2bcdd6&at=AKSUxGN0g5r6LpggqZbcglzOt8PN:1759388822962';
let tiffImage = null;
let pixelScale = null;
let tiePoint = null;
let boundingBox = null;
let rasterWidth = 0;
let rasterHeight = 0;
let populationCrsEpsg = 4326;
let isProjectedCrs = false;

async function loadPopulationTiff() {
    // ... (GeoTIFFロードロジック)
    try {
        const tiff = await fromUrl(WORLDPOP_URL);
        tiffImage = await tiff.getImage(0);
        const fileDirectory = tiffImage.getFileDirectory() || {};
        const tiePoints = fileDirectory.ModelTiepoint;
        pixelScale = fileDirectory.ModelPixelScale || null;
        if (tiePoints && tiePoints.length >= 6) {
            tiePoint = { x: tiePoints[3], y: tiePoints[4], z: tiePoints[5] ?? 0 };
        } else {
            tiePoint = null;
        }
        boundingBox = tiffImage.getBoundingBox();
        rasterWidth = tiffImage.getWidth();
        rasterHeight = tiffImage.getHeight();
        
        // 簡略化のため、CRS判定ロジックは省略し、4326をデフォルトとする
        // 実際の運用ではGeoTIFFのメタデータからCRSを正確に読み取る必要があります。
        
        console.log(`GeoTIFFロード完了。サイズ: ${rasterWidth}x${rasterHeight}`);
    } catch (error) {
        console.error("GeoTIFFのロード中にエラーが発生しました。人口需要はデフォルト値を使用します。", error.message);
        tiffImage = null;
    }
}


async function getPopulationDensityFromCoords(lat, lng) {
    if (!tiffImage) return 50; 
    try {
        let targetX = lng;
        let targetY = lat;
        
        // 座標変換ロジックは複雑なため、今回は4326固定として簡略化
        
        let px;
        let py;
        if (pixelScale && tiePoint) {
            const scaleX = pixelScale[0];
            const scaleY = pixelScale[1];
            if (scaleX && scaleY) {
                px = Math.floor((targetX - tiePoint.x) / scaleX);
                py = Math.floor((tiePoint.y - targetY) / scaleY);
            }
        }
        if ((!Number.isFinite(px) || !Number.isFinite(py)) && boundingBox) {
            const [minX, minY, maxX, maxY] = boundingBox;
            const spanX = maxX - minX;
            const spanY = maxY - minY;
            if (spanX && spanY) {
                px = Math.floor(((targetX - minX) / spanX) * rasterWidth);
                py = Math.floor(((maxY - targetY) / spanY) * rasterHeight);
            }
        }
        if (!Number.isFinite(px) || !Number.isFinite(py) || px < 0 || px >= rasterWidth || py < 0 || py >= rasterHeight) {
            return 50;
        }
        const rasters = await tiffImage.readRasters({ window: [px, py, px + 1, py + 1] });
        let populationValue = null;
        if (Array.isArray(rasters) && rasters.length > 0) {
            const firstBand = rasters[0];
            if (firstBand && firstBand.length > 0) {
                populationValue = firstBand[0];
            }
        } else if (rasters && typeof rasters[0] !== 'undefined') {
            populationValue = rasters[0];
        }
        if (populationValue === null || typeof populationValue === 'undefined' || Number.isNaN(populationValue)) {
            return 50;
        }
        return Math.max(1, Math.round(Number(populationValue)));
    } catch (error) {
        console.error("GeoTIFFからの人口密度取得中にエラー:", error.message);
        return 50;
    }
}
function calculateDemandFromPopulationDensity(populationDensity) {
    const catchmentAreaKm2 = 2;
    const monthlyUseRate = 0.01;
    let localPopulation = populationDensity * catchmentAreaKm2;
    const passengerBase = Math.round(localPopulation * monthlyUseRate * (0.8 + Math.random() * 0.4)); 
    const freightBase = Math.round(passengerBase * 0.1 * (0.8 + Math.random() * 0.4));
    const passengerDemand = Math.max(50, passengerBase);
    const freightDemand = Math.max(10, freightBase);
    return { passenger: passengerDemand, freight: freightDemand };
}

async function getAddressFromCoords(lat, lng) {
    const url = `https://api.mirror-earth.com/nominatim/reverse?lat=${lat}&lon=${lng}&format=json&zoom=16`;
    try {
        const response = await axios.get(url, {
            headers: { "User-Agent": "RailwayTycoonGameServer/1.0", "Accept-Language": "ja,en" }
        });
        const data = response.data;
        if (data.address) {
            const address = data.address;
            let stationNameCandidate;
            if (address.neighbourhood) stationNameCandidate = address.neighbourhood;
            else if (address.suburb) stationNameCandidate = address.suburb;
            else if (address.city_district) stationNameCandidate = address.city_district;
            else if (address.town) stationNameCandidate = address.town;
            else if (address.village) stationNameCandidate = address.village;
            else if (address.city) stationNameCandidate = address.city;
            else if (address.county) stationNameCandidate = address.county;
            else stationNameCandidate = data.display_name.split(',')[0].trim();
            return { stationNameCandidate };
        }
        return { stationNameCandidate: null };
    } catch (error) {
        return { stationNameCandidate: null };
    }
}

async function generateRegionalStationName(lat, lng, isAirport = false) {
    const addressData = await getAddressFromCoords(lat, lng);
    let suffix = isAirport ? '空港' : '駅';
    if (addressData && addressData.stationNameCandidate) {
        let regionalName = addressData.stationNameCandidate;
        let baseName = regionalName.replace(/通り|公園|広場|交差点|ビル|マンション|アパート|[一二三四五六七八九十]丁目|番地|日本|Japan/g, '').trim();
        if (baseName.endsWith(suffix)) { return baseName; }
        if (baseName.length > 10) { baseName = baseName.substring(0, 10); }
        return `${baseName}${suffix}`;
    }
    const randomAreas = ["新興", "郊外", "住宅", "公園", "中央", "東", "西", "南", "北"];
    const randomSuffixes = ["台", "丘", "本", "前", "野", "ヶ原"];
    const area = randomAreas[Math.floor(Math.random() * randomAreas.length)];
    const suffixPart = randomSuffixes[Math.floor(Math.random() * randomSuffixes.length)];
    return `${area}${suffixPart}${suffix}`;
}


function getDistanceKm(coord1, coord2) {
    const lngLat1 = [coord1[1], coord1[0]];
    const lngLat2 = [coord2[1], coord2[0]];
    return turf.distance(turf.point(lngLat1), turf.point(lngLat2), {units: 'kilometers'});
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

function calculateConstructionCost(coord1, coord2, trackType) {
    const distanceKm = getDistanceKm(coord1, coord2);
    if (distanceKm === 0) return { cost: 0, lengthKm: 0, terrainMultiplier: 1.0 };
    const lengthM = distanceKm * 1000;
    
    if (trackType === 'air') {
        const baseCost = distanceKm * 500000;
        return { cost: Math.round(baseCost), lengthKm: distanceKm, terrainMultiplier: 0.1 };
    }
    
    const elev1 = getElevation(coord1[0], coord1[1]);
    const elev2 = getElevation(coord2[0], coord2[1]);
    const elevationDiff = Math.abs(elev1 - elev2);
    let baseCost = distanceKm * 2500000;
    
    let trackMultiplier = 1.0;
    if (trackType === 'double') trackMultiplier = 1.8;
    else if (trackType === 'linear') trackMultiplier = 5.0; 
    else if (trackType === 'tram') trackMultiplier = 0.8; 
    baseCost *= trackMultiplier;
    
    const slope = elevationDiff / lengthM;
    let slopeMultiplier = 1;
    if (slope > 0.1) slopeMultiplier = Math.pow(slope * 15, 3);
    else if (slope > 0.05) slopeMultiplier = Math.pow(slope * 10, 2);
    else if (slope > 0.03) slopeMultiplier = slope * 5;
    
    const slopeCost = slopeMultiplier * 500000 * lengthM; 
    const highElevationCost = Math.max(0, (elev1 + elev2) / 2 - 100) * 5000;
    const totalCost = baseCost + slopeCost + highElevationCost;
    
    // 地形補正率を計算 (ベースコストに対する追加コストの割合)
    const baseCostWithoutTerrain = distanceKm * 2500000 * trackMultiplier;
    const terrainMultiplier = baseCostWithoutTerrain > 0 ? (slopeCost + highElevationCost) / baseCostWithoutTerrain : 0;
    
    return { cost: Math.round(totalCost), lengthKm: distanceKm, terrainMultiplier: 1 + terrainMultiplier };
}

// =================================================================
// B. サーバーサイド・クラス定義
// =================================================================
class ServerStation {
    constructor(id, latlng, ownerId, type = 'Small', initialName = null, initialDemand = null, lineConnections = [], isOverloaded = false, isDemandHigh = false) {
        this.id = id;
        this.latlng = latlng;
        this.ownerId = ownerId;
        this.name = initialName || `仮駅名 ${id}`; 
        this.demand = initialDemand || { 
            passenger: Math.round(50 + Math.random() * 300),
            freight: Math.round(10 + Math.random() * 100)
        };
        this.lineConnections = lineConnections; 
        this.type = type; 
        this.capacity = this.getCapacityByType(type); 
        this.occupyingVehicles = new Set(); 
        this.isAirport = false;
        this.isOverloaded = isOverloaded; 
        this.isDemandHigh = isDemandHigh; 
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

class ServerAirport {
    constructor(id, latlng, ownerId, type = 'Small', initialName = null, lineConnections = [], isOverloaded = false) {
        this.id = id;
        this.latlng = latlng;
        this.ownerId = ownerId;
        this.name = initialName || `仮空港名 ${id}`;
        this.lineConnections = lineConnections;
        this.type = type;
        this.capacity = this.getCapacityByType(type);
        this.occupyingVehicles = new Set();
        this.isAirport = true;
        this.isOverloaded = isOverloaded;
    }

    getCapacityByType(type) {
        switch (type) {
            case 'Medium': return 10;
            case 'Large': return 20;
            case 'Small':
            default: return 5;
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
    constructor(id, line, data, formationSize = 1, initialCargo = { passenger: 0, freight: 0, destinationTerminalId: null }) {
        this.id = id;
        this.lineId = line.id;
        this.ownerId = line.ownerId;
        this.data = data;
        this.formationSize = formationSize; // ★ 編成数を保持
        this.capacity = data.capacity * formationSize; // ★ 容量を編成数で乗算
        this.category = data.category;
        this.coords = line.coords;
        this.terminals = line.stations; 
        
        this.positionKm = 0; 
        this.status = 'Running'; 
        this.isReversed = false; 
        this.stopTimer = 0; 
        this.currentLat = this.coords[0][0];
        this.currentLng = this.coords[0][1];
        this.waitingForStationKm = -1; 
        
        this.cargo = initialCargo; 

        this.totalRouteKm = [0];
        for(let i = 1; i < this.coords.length; i++) {
            const segmentKm = getDistanceKm(this.coords[i-1], this.coords[i]);
            this.totalRouteKm.push(this.totalRouteKm[i-1] + segmentKm);
        }
        this.routeLength = this.totalRouteKm[this.totalRouteKm.length - 1];
    }

    getStationKm(terminal) {
        const COORD_TOLERANCE = 0.000001; 
        
        for(let i = 0; i < this.terminals.length; i++) {
            const t = this.terminals[i];
            if (t.id === terminal.id) {
                for (let j = 0; j < this.coords.length; j++) {
                    if (Math.abs(this.coords[j][0] - t.latlng[0]) < COORD_TOLERANCE && 
                        Math.abs(this.coords[j][1] - t.latlng[1]) < COORD_TOLERANCE) {
                        return this.totalRouteKm[j];
                    }
                }
            }
        }
        return -1; 
    }

    move(gameDeltaSeconds) {
        if (this.category === 'air') {
            this.moveAir(gameDeltaSeconds);
        } else {
            this.moveRail(gameDeltaSeconds);
        }
    }
    
    moveRail(gameDeltaSeconds) {
        if (this.status === 'Stopping') {
            this.stopTimer -= gameDeltaSeconds;
            if (this.stopTimer <= 0) {
                const currentTerminal = this.terminals.find(t => !t.isAirport && this.getStationKm(t) === this.positionKm);
                if (currentTerminal) {
                    currentTerminal.occupyingVehicles.delete(this.id);
                }
                this.status = 'Running';
            }
            return;
        }
        
        if (this.status === 'Waiting') {
            const nextTerminal = this.terminals.find(t => !t.isAirport && this.getStationKm(t) === this.waitingForStationKm);
            if (nextTerminal && nextTerminal.occupyingVehicles.size < nextTerminal.capacity) {
                this.status = 'Running';
                this.waitingForStationKm = -1;
            } else {
                return; 
            }
        }
        
        if (this.status !== 'Running') return;

        const safetyDistance = 1.0; 
        let nextStation = null;
        let minDistance = Infinity;
        
        this.terminals.filter(t => !t.isAirport).forEach(station => {
            const stationKm = this.getStationKm(station);
            if (stationKm === -1) return;
            
            const distance = this.isReversed ? this.positionKm - stationKm : stationKm - this.positionKm;
            
            if (distance > 0 && distance < minDistance) {
                nextStation = station;
                minDistance = distance;
            }
        });
        
        if (nextStation) {
            const nextStationKm = this.getStationKm(nextStation);
            const distanceToStation = this.isReversed ? this.positionKm - nextStationKm : nextStationKm - this.positionKm;
            
            if (distanceToStation < safetyDistance && distanceToStation > 0) {
                if (nextStation.occupyingVehicles.size >= nextStation.capacity) {
                    this.status = 'Waiting';
                    this.waitingForStationKm = nextStationKm; 
                    const stopPositionKm = nextStationKm - (this.isReversed ? -safetyDistance : safetyDistance);
                    this.positionKm = stopPositionKm;
                    this.updateCoordinates();
                    return;
                }
            }
        }

        const speedKms = this.data.maxSpeedKmH / 3600; 
        const travelDistanceKm = speedKms * gameDeltaSeconds; 
        
        const direction = this.isReversed ? -1 : 1;
        this.positionKm += travelDistanceKm * direction;

        if (this.positionKm >= this.routeLength) {
            this.positionKm = this.routeLength;
            this.isReversed = true;
            this.handleTerminalArrival(this.terminals[this.terminals.length-1]);
            return;
        } else if (this.positionKm <= 0) {
            this.positionKm = 0;
            this.isReversed = false;
            this.handleTerminalArrival(this.terminals[0]);
            return;
        }

        this.updateCoordinates();
        this.checkTerminalArrival(1.0); 
    }
    
    moveAir(gameDeltaSeconds) {
        if (this.status === 'Stopping') {
            this.stopTimer -= gameDeltaSeconds;
            if (this.stopTimer <= 0) {
                const currentTerminal = this.terminals.find(t => this.getStationKm(t) === this.positionKm);
                if (currentTerminal) {
                    currentTerminal.occupyingVehicles.delete(this.id);
                }
                this.status = 'Running';
            }
            return;
        }
        
        if (this.status === 'Waiting') {
            const nextTerminal = this.terminals.find(t => this.getStationKm(t) === this.waitingForStationKm);
            if (nextTerminal && nextTerminal.occupyingVehicles.size < nextTerminal.capacity) {
                this.status = 'Running';
                this.waitingForStationKm = -1;
            } else {
                return; 
            }
        }
        
        if (this.status !== 'Running') return;
        
        const speedKms = this.data.maxSpeedKmH / 3600; 
        const travelDistanceKm = speedKms * gameDeltaSeconds; 
        
        const direction = this.isReversed ? -1 : 1;
        this.positionKm += travelDistanceKm * direction;

        if (this.positionKm >= this.routeLength) {
            this.positionKm = this.routeLength;
            this.isReversed = true;
            this.handleTerminalArrival(this.terminals[this.terminals.length-1]);
            return;
        } else if (this.positionKm <= 0) {
            this.positionKm = 0;
            this.isReversed = false;
            this.handleTerminalArrival(this.terminals[0]);
            return;
        }
        
        this.updateCoordinates();
        this.checkTerminalArrival(10.0); 
    }
    
    updateCoordinates() {
        let targetKm = this.positionKm;
        
        let idx = this.totalRouteKm.findIndex(km => km > targetKm);
        if (idx === -1) idx = this.coords.length - 1; 
        
        let startKm = this.totalRouteKm[idx - 1] || 0;
        let endKm = this.totalRouteKm[idx];
        let segmentLength = endKm - startKm;
        
        if (segmentLength === 0) {
            this.currentLat = this.coords[idx][0];
            this.currentLng = this.coords[idx][1];
            return;
        }
        
        let progress = (targetKm - startKm) / segmentLength;
        let prevCoord = this.coords[idx - 1];
        let nextCoord = this.coords[idx];
        
        this.currentLat = prevCoord[0] * (1 - progress) + nextCoord[0] * progress;
        this.currentLng = prevCoord[1] * (1 - progress) + nextCoord[1] * progress;
    }

    checkTerminalArrival(arrivalToleranceKm) {
        
        let closestNextTerminal = null;
        let minDistance = Infinity;
        
        const targetTerminals = this.terminals.filter(t => this.category === 'air' || !t.isAirport);
        
        targetTerminals.forEach(terminal => {
            const terminalKm = this.getStationKm(terminal);
            if (terminalKm === -1) return;
            
            const distance = this.isReversed ? this.positionKm - terminalKm : terminalKm - this.positionKm;
            
            if (distance > 0 && distance < minDistance) {
                closestNextTerminal = terminal;
                minDistance = distance;
            }
        });
        
        if (closestNextTerminal && minDistance < arrivalToleranceKm && this.status === 'Running') {
            const terminalKm = this.getStationKm(closestNextTerminal);
            this.positionKm = terminalKm; 
            this.updateCoordinates(); 
            this.handleTerminalArrival(closestNextTerminal);
        }
    }
    
    // 飛行機収益ロジックと積み込みロジックを修正済み
    handleTerminalArrival(terminal) {
        
        if (terminal.occupyingVehicles.size >= terminal.capacity) {
            this.status = 'Waiting';
            this.waitingForStationKm = this.getStationKm(terminal);
            terminal.isOverloaded = true; 
            
            io.emit('terminalUpdate', { 
                id: terminal.id, 
                isAirport: terminal.isAirport, 
                isOverloaded: terminal.isOverloaded
            });
            return;
        }
        
        // 停車する前に、過負荷状態を解除
        terminal.isOverloaded = false; 
        
        io.emit('terminalUpdate', { 
            id: terminal.id, 
            isAirport: terminal.isAirport, 
            isOverloaded: terminal.isOverloaded
        });

        terminal.occupyingVehicles.add(this.id);
        
        this.status = 'Stopping';
        this.stopTimer = terminal.isAirport ? 60 : 30; 
        
        let revenue = 0;
        const user = ServerGame.users[this.ownerId];
        
        // 1. 貨物の荷降ろしと収益計算
        if (this.cargo.destinationTerminalId === terminal.id) {
            const distance = this.routeLength; 
            const baseRevenue = 5000; 
            
            // 航空機の場合、長距離移動なので収益係数を調整
            const revenueMultiplier = this.category === 'air' ? 5 : 1; 
            
            if (this.data.type === 'passenger') {
                revenue += this.cargo.passenger * distance * baseRevenue / 100 * revenueMultiplier;
                this.cargo.passenger = 0;
            } else if (this.data.type === 'freight') {
                revenue += this.cargo.freight * distance * baseRevenue / 500 * revenueMultiplier;
                this.cargo.freight = 0;
            }
            this.cargo.destinationTerminalId = null;
        }

        // 2. 貨物の積み込み (次の目的地をランダムに決定)
        if (this.cargo.destinationTerminalId === null) {
            const availableTerminals = this.terminals.filter(t => t.id !== terminal.id);
            if (availableTerminals.length > 0) {
                const nextDestination = availableTerminals[Math.floor(Math.random() * availableTerminals.length)];
                this.cargo.destinationTerminalId = nextDestination.id;
                
                const isRailTerminal = !terminal.isAirport;
                
                if (this.data.type === 'passenger') {
                    const availableCapacity = this.capacity - this.cargo.passenger; // ★ this.capacityを使用
                    let loadAmount = 0;
                    
                    if (isRailTerminal) {
                        // 鉄道駅の場合: 駅の需要を参照
                        loadAmount = Math.min(availableCapacity, terminal.demand.passenger * 0.1); 
                        terminal.isDemandHigh = terminal.demand.passenger > this.capacity * 2; // ★ this.capacityを使用
                        io.emit('terminalUpdate', { id: terminal.id, isAirport: false, isDemandHigh: terminal.isDemandHigh });
                    } else { 
                        // 空港の場合: 容量の一定割合を積み込む (航空機収益バグ修正)
                        loadAmount = Math.min(availableCapacity, this.capacity * 0.5 * (0.8 + Math.random() * 0.4)); // ★ this.capacityを使用
                    }
                    this.cargo.passenger += Math.round(loadAmount);
                    
                } else if (this.data.type === 'freight') {
                    const availableCapacity = this.capacity - this.cargo.freight; // ★ this.capacityを使用
                    let loadAmount = 0;
                    
                    if (isRailTerminal) {
                        // 鉄道駅の場合: 駅の需要を参照
                        loadAmount = Math.min(availableCapacity, terminal.demand.freight * 0.1);
                        terminal.isDemandHigh = terminal.demand.freight > this.capacity * 2; // ★ this.capacityを使用
                        io.emit('terminalUpdate', { id: terminal.id, isAirport: false, isDemandHigh: terminal.isDemandHigh });
                    } else {
                         // 空港の場合: 容量の一定割合を積み込む (航空機収益バグ修正)
                        loadAmount = Math.min(availableCapacity, this.capacity * 0.5 * (0.8 + Math.random() * 0.4)); // ★ this.capacityを使用
                    }
                    this.cargo.freight += Math.round(loadAmount);
                }
            }
        }
        
        if (user) {
            user.money += Math.round(revenue);
            user.moneyUpdated = true; 
        }
    }
    
    getDirectionAngle() {
        if (this.coords.length < 2) return 0;

        let targetKm = this.positionKm;
        
        let idx = this.totalRouteKm.findIndex(km => km > targetKm);
        if (idx === -1) idx = this.coords.length - 1; 
        
        let prevCoord, nextCoord;
        
        if (this.isReversed) {
            prevCoord = this.coords[idx];
            nextCoord = this.coords[idx - 1] || this.coords[0];
        } else {
            prevCoord = this.coords[idx - 1] || this.coords[0];
            nextCoord = this.coords[idx] || this.coords[this.coords.length - 1];
        }

        if (!prevCoord || !nextCoord || (prevCoord[0] === nextCoord[0] && prevCoord[1] === nextCoord[1])) return 0;
        
        const startPoint = turf.point([prevCoord[1], prevCoord[0]]);
        const endPoint = turf.point([nextCoord[1], nextCoord[0]]);
        let bearing = turf.bearing(startPoint, endPoint);
        
        bearing = (bearing + 360) % 360;
        
        return bearing;
    }
}
class ServerLineManager {
    constructor(id, ownerId, terminals, coords, cost, lengthKm, color, trackType) {
        this.id = id;
        this.ownerId = ownerId;
        this.stations = terminals; 
        this.coords = coords; 
        this.cost = cost;
        this.lengthKm = lengthKm;
        this.color = color;
        this.trackType = trackType;
        this.vehicles = [];
    }
    async addVehicle(vehicleKey, formationSize = 1) { // ★ formationSizeを追加
        const data = VehicleData[vehicleKey];
        const isAir = data.category === 'air';
        const baseCost = isAir ? AIRPLANE_BASE_COST : VEHICLE_BASE_COST;
        
        // コストを編成数で乗算
        const purchaseCost = baseCost * data.purchaseMultiplier * formationSize; 
        const user = ServerGame.users[this.ownerId];
        
        if (!user || user.money < purchaseCost) {
            return { success: false, message: '資金不足' };
        }
        
        if (isAir && this.trackType !== 'air') {
             return { success: false, message: '航空機は航空路線にのみ配置できます' };
        }
        if (!isAir && this.trackType === 'air') {
             return { success: false, message: '鉄道車両は航空路線に配置できません' };
        }
        
        if (data.name.includes('リニア') && this.trackType !== 'linear') {
             return { success: false, message: 'リニアは専用線路が必要です' };
        }
        if (!data.name.includes('リニア') && this.trackType === 'linear') {
             return { success: false, message: 'リニア線路にはリニア以外配置できません' };
        }
        
        user.money -= purchaseCost;
        
        // 修正: アトミックにIDを取得
        const vehicleId = await getNextId('nextVehicleId');
        
        const newVehicle = new ServerVehicle(vehicleId, this, data, formationSize); // ★ formationSizeを渡す
        this.vehicles.push(newVehicle);
        user.vehicles.push(newVehicle);
        
        const dataKey = Object.keys(VehicleData).find(key => VehicleData[key] === newVehicle.data);
        
        try {
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
                currentLng: newVehicle.currentLng,
                cargo: newVehicle.cargo,
                formationSize: formationSize // ★ DBスキーマに保存
            });
        } catch (error) {
            console.error(`Vehicle ID ${newVehicle.id} の挿入に失敗しました:`, error.message);
            
            // ユーザーの状態をロールバック
            user.money += purchaseCost;
            this.vehicles.pop();
            user.vehicles.pop();
            
            return { success: false, message: '車両IDの重複により購入に失敗しました。サーバー管理者に連絡してください。' };
        }
        
        await saveUserFinancials(user.userId, user.money, user.totalConstructionCost, user.loans);
        
        return { success: true, vehicle: newVehicle };
    }
    runSimulation(gameDeltaSeconds) {
        this.vehicles.forEach(v => v.move(gameDeltaSeconds));
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
        airports: [], 
        allLines: [], 
        lastMonthlyMaintenance: 0,
        newsFeed: [], 
    },
    VehicleData: VehicleData,
};
// =================================================================
// C-1. DB操作関数 (Mongoose)
// =================================================================

/**
 * MongoDBのカウンターをアトミックにインクリメントし、新しい値を取得する
 * @param {string} counterName - GlobalStatsModel内のカウンターフィールド名
 */
async function getNextId(counterName) {
    const result = await GlobalStatsModel.findOneAndUpdate(
        { _id: 1 },
        { $inc: { [counterName]: 1 } },
        { new: true, upsert: true } // new: true で更新後の値を返す
    );
    return result[counterName];
}

// IDカウンターの保存処理を削除し、ゲーム時間と倍速のみを保存するように修正
async function saveGlobalStats() {
    const stats = ServerGame.globalStats;
    await GlobalStatsModel.updateOne({ _id: 1 }, {
        $set: {
            gameTime: stats.gameTime,
            timeScale: stats.timeScale,
        }
    }, { upsert: true }); 
}

async function saveUserFinancials(userId, money, totalConstructionCost, loans = []) {
    await UserModel.updateOne({ userId: userId }, {
        $set: {
            money: money,
            totalConstructionCost: totalConstructionCost,
            loans: loans
        }
    });
}

async function renameTerminal(userId, terminalId, newName, isAirport) {
    const user = ServerGame.users[userId];
    if (!user) return { success: false, message: "ユーザーが見つかりません。" };
    
    const terminalArray = isAirport ? ServerGame.globalStats.airports : ServerGame.globalStats.stations;
    const Model = isAirport ? AirportModel : StationModel;
    
    const globalTerminal = terminalArray.find(t => t.id === terminalId && t.ownerId === userId);
    if (!globalTerminal) return { success: false, message: "あなたのターミナルが見つかりません。" };
    
    globalTerminal.name = newName;
    
    await Model.updateOne(
        { id: terminalId },
        { $set: { name: newName } }
    );
    
    return { success: true, newName: newName, message: `${newName} に名称を変更しました。` };
}

async function saveVehiclePositions() {
    const bulkOps = [];
    
    Object.values(ServerGame.users).forEach(user => {
        user.vehicles.forEach(v => {
            bulkOps.push({
                updateOne: {
                    filter: { id: v.id },
                    update: {
                        $set: {
                            positionKm: v.positionKm,
                            status: v.status,
                            isReversed: v.isReversed,
                            stopTimer: v.stopTimer,
                            currentLat: v.currentLat,
                            currentLng: v.currentLng,
                            cargo: v.cargo,
                            formationSize: v.formationSize
                        }
                    }
                }
            });
        });
    });
    
    if (bulkOps.length > 0) {
        try {
            await VehicleModel.bulkWrite(bulkOps);
        } catch (error) {
            console.error("Failed to bulk write vehicle positions:", error);
        }
    }
}

async function loadUserData(userId) {
    const userRow = await UserModel.findOne({ userId: userId }).lean();
    if (!userRow) return null;

    const user = {
        socketId: null,
        userId: userRow.userId,
        money: userRow.money,
        totalConstructionCost: userRow.totalConstructionCost,
        loans: userRow.loans || [], 
        establishedLines: [],
        vehicles: [],
        moneyUpdated: false, 
    };
    
    let currentLoan = 0;
    let monthlyRepayment = 0;
    user.loans.forEach(loan => {
        currentLoan += loan.remaining;
        monthlyRepayment += loan.monthlyRepayment;
    });
    user.currentLoan = currentLoan;
    user.monthlyRepayment = monthlyRepayment;

    const allTerminals = [...ServerGame.globalStats.stations, ...ServerGame.globalStats.airports];

    const linesRes = await LineModel.find({ ownerId: userId }).lean();
    const lineManagers = linesRes.map(row => {
        const coords = row.coords; 
        
        // 路線に接続されているターミナルを特定するために、座標が一致するターミナルを見つける
        const terminalCoords = coords.filter((coord, index) => {
            // 始点と終点は必ずターミナル
            if (index === 0 || index === coords.length - 1) return true;
            // 中間点もターミナルである可能性がある（路線が複数のターミナルを経由する場合）
            return allTerminals.some(t => t.latlng[0] === coord[0] && t.latlng[1] === coord[1]);
        });

        const lineTerminals = terminalCoords.map(coord => 
            allTerminals.find(t => t.latlng[0] === coord[0] && t.latlng[1] === coord[1])
        ).filter(t => t);
        
        const line = new ServerLineManager(
            row.id, row.ownerId, lineTerminals, coords, 
            row.cost, row.lengthKm, row.color, row.trackType
        );
        return line;
    });
    user.establishedLines = lineManagers;

    const vehiclesRes = await VehicleModel.find({ ownerId: userId }).lean();
    vehiclesRes.forEach(row => {
        const line = user.establishedLines.find(l => l.id === row.lineId);
        if (line) {
            const data = VehicleData[row.dataKey];
            const formationSize = row.formationSize || 1; // ★ formationSizeを取得
            const vehicle = new ServerVehicle(row.id, line, data, formationSize, row.cargo); // ★ formationSizeを渡す
            
            vehicle.positionKm = row.positionKm;
            vehicle.status = row.status;
            vehicle.isReversed = row.isReversed;
            vehicle.stopTimer = row.stopTimer;
            vehicle.currentLat = row.currentLat;
            vehicle.currentLng = row.currentLng;
            
            line.vehicles.push(vehicle);
            user.vehicles.push(vehicle);
        }
    });
    return user;
}

// =================================================================
// C-2. ゲームロジック関数
// =================================================================

async function calculateRanking() {
    const allUsers = await UserModel.find({}).lean();

    const rankingPromises = allUsers.map(async (user) => {
        const totalConstructionCost = user.totalConstructionCost || 0;
        const vehicles = await VehicleModel.find({ ownerId: user.userId }).lean();
        
        let totalVehicleAsset = 0;
        vehicles.forEach(v => {
            const data = VehicleData[v.dataKey];
            const baseCost = data.category === 'air' ? AIRPLANE_BASE_COST : VEHICLE_BASE_COST;
            totalVehicleAsset += baseCost * data.purchaseMultiplier * (v.formationSize || 1);
        });
        
        const loans = Array.isArray(user.loans) ? user.loans : [];
        const totalLoanRemaining = loans.reduce((sum, loan) => sum + (loan?.remaining ?? 0), 0);

        const baseMoney = typeof user.money === 'number' ? user.money : 0;
        // 総資産 = 資金 + 建設投資額 * 70% + 車両資産 * 30% - 負債
        const score = baseMoney + totalConstructionCost * 0.7 + totalVehicleAsset * 0.3 - totalLoanRemaining;

        return {
            userId: user.userId,
            score,
        };
    });

    const ranking = await Promise.all(rankingPromises);

    return ranking
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);
}

async function processMonthlyFinancials() {
    let totalMaintenanceCost = 0;
    
    for (const user of Object.values(ServerGame.users)) {
        let monthlyMaintenance = 0;
        let monthlyRepayment = 0;
        
        user.establishedLines.forEach(line => {
            monthlyMaintenance += line.cost * 0.002; 
        });
        
        user.vehicles.forEach(vehicle => {
            const baseCost = vehicle.category === 'air' ? AIRPLANE_BASE_COST : VEHICLE_BASE_COST;
            const formationFactor = vehicle.formationSize || 1;
            
            // メンテナンスコストは距離ベース + 固定資産税
            monthlyMaintenance += vehicle.data.maintenanceCostPerKm * 1000 * formationFactor; 
            monthlyMaintenance += baseCost * vehicle.data.purchaseMultiplier * 0.001 * formationFactor;
        });
        
        const currentMonth = ServerGame.globalStats.gameTime.getMonth();
        const currentYear = ServerGame.globalStats.gameTime.getFullYear();
        
        user.loans = user.loans.filter(loan => {
            if (loan.remaining <= 0) return false; 
            
            const repayment = loan.monthlyRepayment;
            
            if (user.money < repayment) {
                user.money -= repayment;
                loan.remaining -= repayment;
                monthlyRepayment += repayment;
                ServerGame.globalStats.newsFeed.push(`🚨 ${user.userId} の融資返済が滞りました！`);
            } else {
                user.money -= repayment;
                loan.remaining -= repayment;
                monthlyRepayment += repayment;
            }
            
            loan.remaining = Math.max(0, loan.remaining);
            return loan.remaining > 0;
        });
        
        const userCost = Math.round(monthlyMaintenance);
        user.money -= userCost;
        totalMaintenanceCost += userCost;
        
        user.currentLoan = user.loans.reduce((sum, l) => sum + l.remaining, 0);
        user.monthlyRepayment = user.loans.reduce((sum, l) => sum + l.monthlyRepayment, 0);
        
        await saveUserFinancials(user.userId, user.money, user.totalConstructionCost, user.loans);
        user.moneyUpdated = true;
    }
    ServerGame.globalStats.lastMonthlyMaintenance = totalMaintenanceCost;
}

async function handleLoanRequest(userId, amount, termMonths) {
    const user = ServerGame.users[userId];
    if (!user) return { success: false, message: "ユーザーが見つかりません。" };
    
    const totalAsset = user.money + user.totalConstructionCost * 0.7 + user.vehicles.length * VEHICLE_BASE_COST;
    const maxLoan = totalAsset * MAX_LOAN_RATE;
    
    if (user.currentLoan + amount > maxLoan) {
        return { success: false, message: `借入可能額を超過しています。最大借入可能額: ¥${Math.round(maxLoan).toLocaleString()}` };
    }
    
    const annualInterestRate = ANNUAL_INTEREST_RATE; // 10%
    
    // 簡略化された線形計算を維持しつつ、10%金利を適用
    const totalRepayment = amount * (1 + annualInterestRate * (termMonths / 12));
    const monthlyTotalRepayment = totalRepayment / termMonths;
    
    const newLoan = {
        amount: amount,
        remaining: amount,
        monthlyRepayment: monthlyTotalRepayment,
        interestRate: annualInterestRate,
        termMonths: termMonths,
        startMonth: ServerGame.globalStats.gameTime.getMonth(),
        startYear: ServerGame.globalStats.gameTime.getFullYear()
    };
    
    user.loans.push(newLoan);
    user.money += amount;
    
    user.currentLoan += amount;
    user.monthlyRepayment += newLoan.monthlyRepayment;
    
    await saveUserFinancials(user.userId, user.money, user.totalConstructionCost, user.loans);
    user.moneyUpdated = true;
    
    ServerGame.globalStats.newsFeed.push(`🏦 ${user.userId} が ¥${(amount / 1000000).toFixed(1)}M の融資を受けました。`);
    
    return { success: true, message: `¥${amount.toLocaleString()} の融資が承認されました。` };
}

async function checkTerminalStatus() {
    const allTerminals = [...ServerGame.globalStats.stations, ...ServerGame.globalStats.airports];
    
    for (const terminal of allTerminals) {
        const isOverloaded = terminal.occupyingVehicles.size >= terminal.capacity;
        let needsUpdate = false;
        
        if (terminal.isOverloaded !== isOverloaded) {
            terminal.isOverloaded = isOverloaded;
            needsUpdate = true;
        }
        
        if (!terminal.isAirport) {
            // 駅の需要は、車両容量の200倍を超えたら高いと見なす
            const isDemandHigh = terminal.demand.passenger > terminal.capacity * 200 || terminal.demand.freight > terminal.capacity * 200;
            if (terminal.isDemandHigh !== isDemandHigh) {
                terminal.isDemandHigh = isDemandHigh;
                needsUpdate = true;
            }
        }
        
        if (needsUpdate) {
             io.emit('terminalUpdate', { 
                id: terminal.id, 
                isAirport: terminal.isAirport, 
                isOverloaded: terminal.isOverloaded,
                isDemandHigh: terminal.isDemandHigh
            });
        }
    }
}

async function triggerRandomEvent() {
    // 確率を0.005から0.0005に大幅に引き下げ (10秒に1回チェックとして、平均で1000秒に1回=約16.7分に1回発生)
    if (Math.random() < 0.0005) { 
        const allStations = ServerGame.globalStats.stations;
        if (allStations.length === 0) return;
        
        const targetStation = allStations[Math.floor(Math.random() * allStations.length)];
        const factor = 1 + Math.random() * 0.5; 
        
        targetStation.demand.passenger = Math.round(targetStation.demand.passenger * factor);
        targetStation.demand.freight = Math.round(targetStation.demand.freight * factor);
        
        await StationModel.updateOne(
            { id: targetStation.id },
            { $set: { demand: targetStation.demand } }
        );
        
        const news = `📈 ${targetStation.name} 周辺で急な開発が行われ、需要が ${Math.round((factor - 1) * 100)}% 増加しました！`;
        ServerGame.globalStats.newsFeed.push(news);
        
        io.emit('terminalUpdate', { 
            id: targetStation.id, 
            isAirport: false, 
            demand: targetStation.demand 
        });
    }
}


async function dismantleLine(userId, lineId) {
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
    
    vehiclesOnLine.forEach(v => {
        const baseCost = v.category === 'air' ? AIRPLANE_BASE_COST : VEHICLE_BASE_COST;
        // 編成数を考慮して売却額を計算
        const purchaseCost = baseCost * v.data.purchaseMultiplier * (v.formationSize || 1); 
        const saleRevenue = Math.round(purchaseCost / 3);
        user.money += saleRevenue;
        totalVehicleSaleRevenue += saleRevenue;
    });
    user.vehicles = user.vehicles.filter(v => v.lineId !== lineId);
    await VehicleModel.deleteMany({ lineId: lineId });
    
    user.establishedLines.splice(lineIndex, 1);
    user.totalConstructionCost -= lineToDismantle.cost;
    await LineModel.deleteOne({ id: lineId });
    
    ServerGame.globalStats.allLines = ServerGame.globalStats.allLines.filter(l => l.id !== lineId);
    
    const allTerminals = [...ServerGame.globalStats.stations, ...ServerGame.globalStats.airports];
    
    const updatePromises = [];
    for (const terminal of lineToDismantle.stations) {
        const globalTerminal = allTerminals.find(t => t.id === terminal.id);
        if (globalTerminal) {
            globalTerminal.lineConnections = globalTerminal.lineConnections.filter(id => id !== lineId);
            const Model = globalTerminal.isAirport ? AirportModel : StationModel;
            updatePromises.push(Model.updateOne(
                { id: globalTerminal.id },
                { $set: { lineConnections: globalTerminal.lineConnections } }
            ));
            
            // 接続路線情報が変更されたことをクライアントに通知
            io.emit('terminalUpdate', { 
                id: globalTerminal.id, 
                isAirport: globalTerminal.isAirport, 
                lineConnections: globalTerminal.lineConnections 
            });
        }
    }
    await Promise.all(updatePromises);
    
    await saveUserFinancials(user.userId, user.money, user.totalConstructionCost, user.loans);
    return { 
        success: true, 
        message: `路線 ${lineId} を解体しました。車両売却収益: ¥${totalVehicleSaleRevenue.toLocaleString()}`,
        lineId: lineId,
        dismantleCost: dismantleCost
    };
}

async function dismantleTerminal(userId, terminalId, isAirport) {
    const user = ServerGame.users[userId];
    if (!user) return { success: false, message: "ユーザーが見つかりません。" };
    
    const terminalArray = isAirport ? ServerGame.globalStats.airports : ServerGame.globalStats.stations;
    const Model = isAirport ? AirportModel : StationModel;
    const cost = isAirport ? AIRPORT_COST : STATION_COST;
    const typeName = isAirport ? '空港' : '駅';
    
    const globalTerminalIndex = terminalArray.findIndex(s => s.id === terminalId && s.ownerId === userId);
    if (globalTerminalIndex === -1) return { success: false, message: `あなたの${typeName}が見つかりません。` };
    const terminalToDismantle = terminalArray[globalTerminalIndex];
    
    if (terminalToDismantle.lineConnections.length > 0) {
        return { success: false, message: `この${typeName}には路線が接続されています。先に路線をすべて解体してください。` };
    }
    
    const dismantleCost = Math.round(cost * 0.1);
    if (user.money < dismantleCost) return { success: false, message: "解体費用が不足しています。" };
    user.money -= dismantleCost;
    user.totalConstructionCost -= cost; 

    terminalArray.splice(globalTerminalIndex, 1);
    await Model.deleteOne({ id: terminalId });
    
    await saveUserFinancials(user.userId, user.money, user.totalConstructionCost, user.loans);
    return { 
        success: true, 
        message: `${typeName} ${terminalToDismantle.name} (ID: ${terminalId}) を解体しました。`, 
        terminalId: terminalId,
        isAirport: isAirport,
        dismantleCost: dismantleCost
    };
}

async function upgradeStation(userId, stationId, newType, cost) {
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
    user.totalConstructionCost += cost; 
    await saveUserFinancials(user.userId, user.money, user.totalConstructionCost, user.loans);
    
    return { 
        success: true, 
        type: newType, 
        capacity: newCapacity,
        message: `${globalStation.name} を ${newType} 駅にアップグレードしました。`
    };
}

let lastSimTime = performance.now();
let lastSaveTime = performance.now(); 
let lastEventTime = performance.now(); 
async function serverSimulationLoop() { 
    const currentTime = performance.now();
    const deltaTimeMs = currentTime - lastSimTime;
    lastSimTime = currentTime;
    
    const gameDeltaSeconds = (deltaTimeMs / 1000) * ServerGame.globalStats.timeScale;
    
    const gameTime = ServerGame.globalStats.gameTime;
    const prevMonth = gameTime.getMonth();
    gameTime.setTime(gameTime.getTime() + (deltaTimeMs * ServerGame.globalStats.timeScale));
    const nowMonth = gameTime.getMonth();
    
    let newsToSend = null;
    
    if (nowMonth !== prevMonth) {
        await processMonthlyFinancials(); 
        await saveGlobalStats(); 
    }
    
    if (currentTime - lastEventTime > 5000) { 
        await triggerRandomEvent();
        lastEventTime = currentTime;
        
        if (ServerGame.globalStats.newsFeed.length > 0) {
            newsToSend = ServerGame.globalStats.newsFeed.shift();
        }
        
        await checkTerminalStatus();
    }
    
    const vehiclePositions = [];
    const usersToUpdateFinancials = []; 
    
    Object.values(ServerGame.users).forEach(user => {
        user.establishedLines.forEach(line => {
            line.runSimulation(gameDeltaSeconds); 
        });
        
        user.vehicles.forEach(v => {
            let rotationAngle = v.category === 'air' ? v.getDirectionAngle() : 0; 
            
            vehiclePositions.push({
                id: v.id,
                owner: user.userId,
                latlng: [v.currentLat, v.currentLng], 
                color: v.data.color,
                status: v.status,
                category: v.category,
                rotation: rotationAngle,
                formationSize: v.formationSize // ★ 編成数を追加
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
                totalConstructionCost: user.totalConstructionCost,
                currentLoan: user.currentLoan,
                monthlyRepayment: user.monthlyRepayment,
                vehicles: user.vehicles.map(v => ({ id: v.id, data: v.data })), 
            });
        }
    });

    if (currentTime - lastSaveTime > 5000) {
        await saveVehiclePositions();
        lastSaveTime = currentTime;
    }

    io.emit('gameUpdate', {
        time: gameTime.toISOString(),
        vehiclePositions: vehiclePositions,
        globalStats: {
            timeScale: ServerGame.globalStats.timeScale,
            stationsCount: ServerGame.globalStats.stations.length,
            airportsCount: ServerGame.globalStats.airports.length,
            lastMonthlyMaintenance: ServerGame.globalStats.lastMonthlyMaintenance,
            news: newsToSend
        }
    });
    
    // ランキングの計算と送信
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
        const userRow = await UserModel.findOne({ userId: username }).lean();
        
        if (userRow) {
            if (userRow.password !== password) {
                return res.status(401).send({ message: "パスワードが違います。" });
            }
        } else {
            await UserModel.create({
                userId: username,
                password: password,
                money: 5000000000,
                totalConstructionCost: 0
            });
            console.log(`新規ユーザー登録: ${username}`);
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
            currentLoan: userState.currentLoan, 
            monthlyRepayment: userState.monthlyRepayment, 
            establishedLines: clientLines, 
            allLines: allClientLines, 
            vehicles: userState.vehicles.map(v => ({ id: v.id, data: v.data, formationSize: v.formationSize })), // ★ formationSizeを送信
            stations: ServerGame.globalStats.stations.map(s => ({ 
                id: s.id, latlng: [s.lat, s.lng], ownerId: s.ownerId, type: s.type, capacity: s.capacity, name: s.name, demand: s.demand, lineConnections: s.lineConnections, isOverloaded: s.isOverloaded, isDemandHigh: s.isDemandHigh
            })), 
            airports: ServerGame.globalStats.airports.map(a => ({
                id: a.id, latlng: [a.lat, a.lng], ownerId: a.ownerId, type: a.type, capacity: a.capacity, name: a.name, lineConnections: a.lineConnections, isOverloaded: a.isOverloaded
            })),
            vehicleData: ServerGame.VehicleData,
        });
        
        const chatHistory = await ChatModel.find({})
            .sort({ timestamp: -1 })
            .limit(50)
            .lean();
            
        socket.emit('chatHistory', chatHistory.reverse().map(msg => ({
            userId: msg.userId,
            message: msg.message,
            timestamp: msg.timestamp.toISOString()
        })));
    });
    
    socket.on('calculateConstructionCost', (data, callback) => {
        if (!data.coords || data.coords.length < 2) {
            return callback({ success: false, message: "座標が不足しています。" });
        }
        
        let totalCost = 0;
        let totalLengthKm = 0;
        let totalTerrainMultiplier = 0; 
        
        for (let i = 1; i < data.coords.length; i++) {
            const coord1 = data.coords[i-1];
            const coord2 = data.coords[i];
            // 地形補正を計算に含める
            const { cost: segCost, lengthKm: segLength, terrainMultiplier: segTerrain } = calculateConstructionCost(coord1, coord2, data.trackType);
            totalCost += segCost;
            totalLengthKm += segLength;
            totalTerrainMultiplier += segTerrain;
        }
        
        if (data.trackType === 'air') {
            totalCost += 100000000; 
        }
        
        const avgTerrainMultiplier = totalTerrainMultiplier / (data.coords.length - 1);
        
        callback({ success: true, totalCost: totalCost, totalLengthKm: totalLengthKm, avgTerrainMultiplier: avgTerrainMultiplier });
    });
    
    socket.on('requestLoan', async (data) => {
        if (!userId) return;
        
        const amountM = data.amount / 1000000;
        const result = await handleLoanRequest(userId, data.amount, data.termMonths);
        
        if (result.success) {
            socket.emit('info', result.message);
        } else {
            socket.emit('error', result.message);
        }
    });

    socket.on('buildStation', async (data) => {
        if (!userId) return;
        const user = ServerGame.users[userId];
        const latlng = data.latlng; 
        
        if (user.money < STATION_COST) {
            socket.emit('error', '資金不足で駅を建設できません。');
            return;
        }
        
        try {
            const newStationPoint = turf.point([latlng[1], latlng[0]]); 
            const exclusionRadiusKm = 0.5; 
            
            const allTerminals = [...ServerGame.globalStats.stations, ...ServerGame.globalStats.airports];

            for (const existingTerminal of allTerminals) {
                if (existingTerminal.ownerId === userId) continue;
                
                const existingPoint = turf.point([existingTerminal.lng, existingTerminal.lat]);
                const distanceKm = turf.distance(newStationPoint, existingPoint, { units: 'kilometers' });
                
                if (distanceKm < exclusionRadiusKm) {
                    socket.emit('error', `他のプレイヤー (${existingTerminal.ownerId}) の施設が ${Math.round(distanceKm * 1000)}m 以内にあります。建設できません。`);
                    return;
                }
            }

            // 修正: アトミックにIDを取得
            const stationId = await getNextId('nextStationId');
            
            await sleep(500); 
            
            const newStationName = await generateRegionalStationName(latlng[0], latlng[1], false);
            
            const populationDensity = await getPopulationDensityFromCoords(latlng[0], latlng[1]);
            const calculatedDemand = calculateDemandFromPopulationDensity(populationDensity);
            
            const newStation = new ServerStation(stationId, latlng, userId, 'Small', newStationName, calculatedDemand, []); 
            
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
            user.totalConstructionCost += STATION_COST;
            ServerGame.globalStats.stations.push(newStation);
            
            await saveUserFinancials(user.userId, user.money, user.totalConstructionCost, user.loans);
            
            io.emit('stationBuilt', { 
                latlng: latlng, id: newStation.id, ownerId: userId, type: newStation.type, capacity: newStation.capacity, name: newStation.name, demand: newStation.demand, lineConnections: [] 
            });
            socket.emit('updateUserState', { 
                money: user.money,
                totalConstructionCost: user.totalConstructionCost,
                currentLoan: user.currentLoan,
                monthlyRepayment: user.monthlyRepayment,
                vehicles: user.vehicles.map(v => ({ id: v.id, data: v.data })), 
            });
        } catch (error) {
            console.error("buildStation error:", error);
            socket.emit('error', '駅の建設中にエラーが発生しました。');
        }
    });
    
    socket.on('buildAirport', async (data) => {
        if (!userId) return;
        const user = ServerGame.users[userId];
        const latlng = data.latlng; 
        
        if (user.money < AIRPORT_COST) {
            socket.emit('error', `資金不足で空港を建設できません。 (必要: ¥${AIRPORT_COST.toLocaleString()})`);
            return;
        }
        
        try {
            const newAirportPoint = turf.point([latlng[1], latlng[0]]); 
            const exclusionRadiusKm = 5; 
            
            const allTerminals = [...ServerGame.globalStats.stations, ...ServerGame.globalStats.airports];

            for (const existingTerminal of allTerminals) {
                const existingPoint = turf.point([existingTerminal.lng, existingTerminal.lat]);
                const distanceKm = turf.distance(newAirportPoint, existingPoint, { units: 'kilometers' });
                
                if (distanceKm < exclusionRadiusKm) {
                    socket.emit('error', `既存のターミナルが ${Math.round(distanceKm)}km 以内にあります。建設できません。`);
                    return;
                }
            }

            // 修正: アトミックにIDを取得
            const airportId = await getNextId('nextStationId'); 
            
            await sleep(500); 
            const newAirportName = await generateRegionalStationName(latlng[0], latlng[1], true);
            
            const newAirport = new ServerAirport(airportId, latlng, userId, 'Small', newAirportName, []); 
            
            await AirportModel.create({
                id: newAirport.id,
                ownerId: newAirport.ownerId,
                lat: latlng[0],
                lng: latlng[1],
                name: newAirport.name, 
                lineConnections: newAirport.lineConnections,
                type: newAirport.type, 
                capacity: newAirport.capacity 
            });

            user.money -= AIRPORT_COST;
            user.totalConstructionCost += AIRPORT_COST;
            ServerGame.globalStats.airports.push(newAirport);
            
            await saveUserFinancials(user.userId, user.money, user.totalConstructionCost, user.loans);
            
            io.emit('airportBuilt', { 
                latlng: latlng, id: newAirport.id, ownerId: userId, type: newAirport.type, capacity: newAirport.capacity, name: newAirport.name, lineConnections: []
            });
            socket.emit('updateUserState', { 
                money: user.money,
                totalConstructionCost: user.totalConstructionCost,
                currentLoan: user.currentLoan,
                monthlyRepayment: user.monthlyRepayment,
                vehicles: user.vehicles.map(v => ({ id: v.id, data: v.data })), 
            });
        } catch (error) {
            console.error("buildAirport error:", error);
            socket.emit('error', '空港の建設中にエラーが発生しました。');
        }
    });

    socket.on('upgradeStation', async (data) => {
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
                totalConstructionCost: user.totalConstructionCost,
                currentLoan: user.currentLoan,
                monthlyRepayment: user.monthlyRepayment,
                vehicles: user.vehicles.map(v => ({ id: v.id, data: v.data })), 
            });
            socket.emit('info', result.message);
        } else {
            socket.emit('error', result.message);
        }
    });
    
    socket.on('renameTerminal', async (data) => {
        if (!userId) return;
        
        const result = await renameTerminal(userId, data.terminalId, data.newName, data.isAirport);
        
        if (result.success) {
            io.emit('terminalRenamed', { 
                id: data.terminalId, 
                newName: result.newName,
                isAirport: data.isAirport
            });
            socket.emit('info', result.message);
        } else {
            socket.emit('error', result.message);
        }
    });

    socket.on('buildLine', async (data) => {
        if (!userId || data.terminalCoords.length < 2) return;
        
        const user = ServerGame.users[userId];
        
        // 修正: アトミックにIDを取得
        const lineId = await getNextId('nextLineId');
        
        const lineColor = LINE_COLORS[lineId % LINE_COLORS.length];
        const trackType = data.trackType;
        const isAirRoute = trackType === 'air';
        
        let fullCoords = [];
        let totalCost = 0;
        let totalLengthKm = 0;
        
        for (let i = 1; i < data.terminalCoords.length; i++) {
            const coord1 = data.terminalCoords[i-1];
            const coord2 = data.terminalCoords[i];
            
            const segmentCoords = isAirRoute 
                ? calculateGreatCirclePath(coord1, coord2)
                : [coord1, coord2]; 
            
            if (i > 0 && fullCoords.length > 0) {
                segmentCoords.shift(); 
            }
            
            fullCoords = fullCoords.concat(segmentCoords);
            
            const { cost: segCost, lengthKm: segLength } = calculateConstructionCost(coord1, coord2, trackType);
            totalCost += segCost;
            totalLengthKm += segLength;
        }
        
        if (isAirRoute) {
            totalCost += 100000000; 
        }
        
        if (user.money < totalCost) {
            socket.emit('error', `資金不足です！路線建設費用: ¥${totalCost.toLocaleString()}`);
            return;
        }
        try {
            user.money -= totalCost;
            user.totalConstructionCost += totalCost;
            await saveUserFinancials(user.userId, user.money, user.totalConstructionCost, user.loans);

            const allTerminals = [...ServerGame.globalStats.stations, ...ServerGame.globalStats.airports];
            const lineTerminals = data.terminalCoords.map(coord => 
                allTerminals.find(t => t.latlng[0] === coord[0] && t.latlng[1] === coord[1])
            ).filter(t => t);
            
            const newLineManager = new ServerLineManager(
                lineId, userId, lineTerminals, fullCoords, totalCost, totalLengthKm, lineColor, trackType
            );
            user.establishedLines.push(newLineManager);
            
            await LineModel.create({
                id: lineId,
                ownerId: userId,
                coords: fullCoords, 
                cost: totalCost,
                lengthKm: totalLengthKm,
                color: lineColor,
                trackType: trackType
            });
            
            ServerGame.globalStats.allLines.push({
                id: lineId, ownerId: userId, coords: fullCoords, color: lineColor, trackType: trackType, cost: totalCost, lengthKm: totalLengthKm
            });
            
            const updatePromises = [];
            for (const terminal of lineTerminals) {
                terminal.addLine(lineId);
                const Model = terminal.isAirport ? AirportModel : StationModel;
                updatePromises.push(Model.updateOne(
                    { id: terminal.id },
                    { $set: { lineConnections: terminal.lineConnections } }
                ));
                
                // 接続路線情報をリアルタイムで通知
                io.emit('terminalUpdate', { 
                    id: terminal.id, 
                    isAirport: terminal.isAirport, 
                    lineConnections: terminal.lineConnections 
                });
            }
            await Promise.all(updatePromises);

            io.emit('lineBuilt', {
                ownerId: userId, id: lineId, coords: fullCoords, color: lineColor, 
                trackType: trackType, cost: totalCost, lengthKm: totalLengthKm
            });
            
            socket.emit('updateUserState', { 
                money: user.money, 
                totalConstructionCost: user.totalConstructionCost,
                currentLoan: user.currentLoan,
                monthlyRepayment: user.monthlyRepayment,
                establishedLines: user.establishedLines.map(line => ({ 
                    id: line.id, ownerId: line.ownerId, 
                    coords: line.coords, color: line.color, 
                    trackType: line.trackType, cost: line.cost 
                })),
                vehicles: user.vehicles.map(v => ({ id: v.id, data: v.data })), 
            });
        } catch (error) {
            console.error("buildLine error:", error);
            socket.emit('error', '路線/航空路線の建設中にエラーが発生しました。');
        }
    });
    
    socket.on('buyVehicle', async (data) => {
        if (!userId) return;
        
        const user = ServerGame.users[userId];
        const line = user.establishedLines.find(l => l.id == data.lineId);
        
        if (line) {
            const result = await line.addVehicle(data.vehicleKey, data.formationSize); 
            if (result.success) {
                socket.emit('updateUserState', {
                    money: user.money,
                    currentLoan: user.currentLoan,
                    monthlyRepayment: user.monthlyRepayment,
                    vehicles: user.vehicles.map(v => ({ id: v.id, data: v.data, formationSize: v.formationSize })),
                });
                socket.emit('info', `${result.vehicle.data.name} (${result.vehicle.formationSize}編成) を購入しました。`);
            } else {
                socket.emit('error', `購入失敗: ${result.message}`);
            }
        }
    });
    
    socket.on('dismantleLine', async (data) => {
        if (!userId) return;
        
        const result = await dismantleLine(userId, data.lineId); 
        
        if (result.success) {
            io.emit('lineDismantled', { lineId: result.lineId, ownerId: userId });
            
            const user = ServerGame.users[userId];
            socket.emit('updateUserState', {
                money: user.money,
                totalConstructionCost: user.totalConstructionCost,
                currentLoan: user.currentLoan,
                monthlyRepayment: user.monthlyRepayment,
                establishedLines: user.establishedLines.map(l => ({ id: l.id, ownerId: l.ownerId, coords: l.coords, color: l.color, trackType: l.trackType, cost: l.cost })),
                vehicles: user.vehicles.map(v => ({ id: v.id, data: v.data })),
            });
            socket.emit('info', result.message);
        } else {
            socket.emit('error', result.message);
        }
    });
    
    socket.on('dismantleTerminal', async (data) => {
        if (!userId) return;
        
        const result = await dismantleTerminal(userId, data.terminalId, data.isAirport); 
        
        if (result.success) {
            io.emit('stationDismantled', { terminalId: result.terminalId, ownerId: userId, isAirport: result.isAirport });
            
            const user = ServerGame.users[userId];
            socket.emit('updateUserState', {
                money: user.money,
                totalConstructionCost: user.totalConstructionCost,
                currentLoan: user.currentLoan,
                monthlyRepayment: user.monthlyRepayment,
                vehicles: user.vehicles.map(v => ({ id: v.id, data: v.data })),
            });
            socket.emit('info', result.message);
        } else {
            socket.emit('error', result.message);
        }
    });
    
    socket.on('sendMessage', async (data) => {
        if (!userId || !data.message || data.message.trim() === '') return;
        
        const message = data.message.trim().substring(0, 200); 
        
        try {
            const chatMessage = await ChatModel.create({
                userId: userId,
                message: message,
                timestamp: new Date()
            });
            
            io.emit('newMessage', {
                userId: chatMessage.userId,
                message: chatMessage.message,
                timestamp: chatMessage.timestamp.toISOString()
            });
        } catch (error) {
            console.error("Chat message save error:", error);
            socket.emit('error', 'チャットメッセージの送信中にエラーが発生しました。');
        }
    });
    
    socket.on('disconnect', () => {
        // ...
    });
});
// =================================================================
// E. サーバー起動ロジック
// =================================================================

/**
 * 既存のコレクションから最大IDを取得し、GlobalStatsModelのカウンターを初期化する
 */
async function initializeDatabase() {
    // 1. GlobalStatsModelの存在確認
    let stats = await GlobalStatsModel.findById(1);

    // 2. 最大IDの取得
    const maxStationId = (await StationModel.findOne().sort({ id: -1 }).select('id').lean())?.id || 0;
    const maxAirportId = (await AirportModel.findOne().sort({ id: -1 }).select('id').lean())?.id || 0;
    const maxLineId = (await LineModel.findOne().sort({ id: -1 }).select('id').lean())?.id || 0;
    const maxVehicleId = (await VehicleModel.findOne().sort({ id: -1 }).select('id').lean())?.id || 0;

    const nextStationId = Math.max(maxStationId, maxAirportId) + 1;
    const nextLineId = maxLineId + 1;
    const nextVehicleId = maxVehicleId + 1;
    
    console.log(`DB最大ID: 駅/空港=${Math.max(maxStationId, maxAirportId)}, 路線=${maxLineId}, 車両=${maxVehicleId}`);
    console.log(`カウンター初期値: nextStationId=${nextStationId}, nextLineId=${nextLineId}, nextVehicleId=${nextVehicleId}`);

    if (!stats) {
        // 存在しない場合は新規作成
        await GlobalStatsModel.create({
            _id: 1,
            gameTime: new Date(2025, 0, 1, 0, 0, 0),
            timeScale: 60,
            nextStationId: nextStationId,
            nextLineId: nextLineId,
            nextVehicleId: nextVehicleId
        });
    } else {
        // 存在する場合はカウンターを更新 (既存の値より大きい場合のみ)
        const update = {};
        if (stats.nextStationId < nextStationId) update.nextStationId = nextStationId;
        if (stats.nextLineId < nextLineId) update.nextLineId = nextLineId;
        if (stats.nextVehicleId < nextVehicleId) update.nextVehicleId = nextVehicleId;

        if (Object.keys(update).length > 0) {
            await GlobalStatsModel.updateOne({ _id: 1 }, { $set: update });
            console.log("GlobalStatsカウンターを既存の最大IDに合わせて更新しました:", update);
        }
    }
}

async function loadGlobalStats() {
    const statsRow = await GlobalStatsModel.findById(1).lean();
    if (statsRow) {
        ServerGame.globalStats.gameTime = new Date(statsRow.gameTime);
        ServerGame.globalStats.timeScale = statsRow.timeScale;
    }

    const stationsRes = await StationModel.find({}).lean();
    ServerGame.globalStats.stations = stationsRes.map(row => {
        let stationName = row.name;
        if (!stationName || stationName.startsWith("駅 ") || stationName.includes("新駅") || stationName.includes("仮駅名")) { 
             stationName = row.name || `仮駅名 ${row.id}`;
        }
        
        const station = new ServerStation(
            row.id, 
            [row.lat, row.lng], 
            row.ownerId, 
            row.type || 'Small', 
            stationName,
            row.demand,
            row.lineConnections || []
        ); 
        station.demand = row.demand; 
        station.capacity = station.getCapacityByType(station.type); 
        return station;
    });
    
    const airportsRes = await AirportModel.find({}).lean();
    ServerGame.globalStats.airports = airportsRes.map(row => {
        const airport = new ServerAirport(
            row.id, 
            [row.lat, row.lng], 
            row.ownerId, 
            row.type || 'Small', 
            row.name,
            row.lineConnections || []
        );
        airport.capacity = airport.getCapacityByType(airport.type); 
        return airport;
    });
    
    // 仮駅名更新ロジックは省略

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
        
        // データベースの初期化とカウンターの調整を最初に行う
        await initializeDatabase();
        
        // GeoTIFF関連のライブラリがNode.js環境で利用可能であることを確認してください
        if (typeof fromUrl !== 'undefined') {
            await loadPopulationTiff(); 
            if (!tiffImage) {
                console.warn('人口GeoTIFFが利用できないため、人口需要はデフォルト値になります。');
            }
        } else {
             console.warn('GeoTIFFライブラリが見つからないため、人口需要はデフォルト値になります。');
        }
        
        await loadGlobalStats();
        
        // Node.js v16以降ではグローバルにあることが多いが、念のためチェック
        if (typeof global.performance === 'undefined') {
            global.performance = performance;
        }

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
