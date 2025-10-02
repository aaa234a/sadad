// server.js
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const cookieParser = require('cookie-parser');
const path = require('path');
const turf = require('@turf/turf'); 
const mongoose = require('mongoose');
const axios = require('axios'); 
const { fromUrl } = require('geotiff'); // ★ GeoTIFFライブラリ
const proj4 = require('proj4'); // ★ 座標変換ライブラリ
require('dotenv').config();

const app = express();
const PORT = process.env.ENV_PORT || 3000; 
const server = http.createServer(app);
const io = socketio(server);

// =================================================================
// 0. データベース接続とMongooseスキーマ定義 (変更なし)
// =================================================================
// ... (Mongoose Schemas の定義は省略 - 変更なし)
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
    capacity: { type: Number, default: 3 }, // 停車可能列車数
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

const ChatSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    message: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
}, { collection: 'chat_messages' });
const ChatModel = mongoose.model('Chat', ChatSchema);


// =================================================================
// A. サーバーサイド・ゲーム定数とユーティリティ (変更なし)
// =================================================================
const STATION_COST = 50000000;
const VEHICLE_BASE_COST = 8000000;
const LINE_COLORS = ['#E4007F', '#009933', '#0000FF', '#FFCC00', '#FF6600', '#9900CC'];
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

// =================================================================
// ★ GeoTIFF人口データ処理ロジック (修正)
// =================================================================
const WORLDPOP_URL = 'https://drive.usercontent.google.com/download?id=1RXhkeCoPf5gDpz7kO40wn4x4646sXNqq&export=download&authuser=0&confirm=t&uuid=ad389895-3ad2-4345-a5b8-fdfc6a2bcdd6&at=AKSUxGN0g5r6LpggqZbcglzOt8PN:1759388822962';

let tiffImage = null;
let geoKeyDirectory = null;
let pixelScale = null;

// WorldPopのデータは通常WGS84（EPSG:4326）ですが、念のため座標変換を定義
// WGS84 to WGS84 は不要だが、GeoTIFFのCRSが異なる場合に備えて残す
// proj4.default('EPSG:4326', 'EPSG:4326');

async function loadPopulationTiff() {
    try {
        console.log(`GeoTIFFを外部URLからロード中: ${WORLDPOP_URL}`);
        
        // ★ 外部URLからGeoTIFFをロード
        const tiff = await fromUrl(WORLDPOP_URL);
        tiffImage = await tiff.getImage(0);
        
        // GeoTIFFのメタデータ（座標情報）を取得
        const geoKeys = tiffImage.getGeoKeys();
        geoKeyDirectory = geoKeys.GeoKeyDirectory;
        
        // ピクセルと地理座標のスケールを取得
        pixelScale = tiffImage.getFileDirectory().ModelPixelScale;

        console.log(`GeoTIFFロード完了。サイズ: ${tiffImage.getWidth()}x${tiffImage.getHeight()}`);
        console.log(`GeoTIFFのCRSはEPSG:${geoKeyDirectory[1024] || '不明'}を想定`);
    } catch (error) {
        console.error("GeoTIFFのロード中にエラーが発生しました。人口需要はデフォルト値を使用します。", error.message);
        tiffImage = null;
    }
}

/**
 * 緯度・経度からGeoTIFFの人口密度を取得する
 * @param {number} lat 緯度 (WGS84)
 * @param {number} lng 経度 (WGS84)
 * @returns {number} 人口密度 (人/km²)
 */
async function getPopulationDensityFromCoords(lat, lng) {
    if (!tiffImage) return 50; // ロード失敗時は最低値を返す

    try {
        // 1. WGS84 (lat, lng) を GeoTIFFのCRSに変換
        let x, y;
        const targetCRS = geoKeyDirectory[1024]; // GeoTIFFのCRSを取得
        
        if (targetCRS && targetCRS !== 4326) {
             // GeoTIFFのCRSがWGS84以外の場合、変換が必要
             const fromProj = 'EPSG:4326';
             const toProj = `EPSG:${targetCRS}`;
             
             // proj4に変換を定義
             const converter = proj4.default(fromProj, toProj);
             [x, y] = converter.forward([lng, lat]);
        } else {
             // GeoTIFFがWGS84（EPSG:4326）の場合
             x = lng;
             y = lat;
        }

        // 2. 地理座標 (x, y) をピクセル座標 (px, py) に変換
        const [originX, originY] = tiffImage.getOrigin();
        const [resX, resY] = tiffImage.getResolution();
        
        // ピクセル座標を計算
        const px = Math.floor((x - originX) / resX);
        const py = Math.floor((originY - y) / resY); // Y軸は反転していることが多い

        // 3. ピクセル座標がGeoTIFFの範囲内にあるか確認
        if (px < 0 || px >= tiffImage.getWidth() || py < 0 || py >= tiffImage.getHeight()) {
            return 50; // 範囲外は低人口密度
        }

        // 4. ピクセル値（人口総数）を読み取り
        const rasters = await tiffImage.readRasters({ window: [px, py, px + 1, py + 1] });
        
        if (rasters && rasters.length > 0 && rasters[0].length > 0) {
            const population = rasters[0][0];
            // WorldPopのデータはメッシュ内の人口総数（人）。1kmメッシュなので、これが人口密度（人/km²）となる。
            return Math.max(1, Math.round(population));
        }

        return 50;
    } catch (error) {
        console.error("GeoTIFFからの人口密度取得中にエラー:", error.message);
        return 50;
    }
}

// =================================================================
// ★ 人口密度に基づいた需要計算関数 (変更なし)
// =================================================================
/**
 * 人口密度に基づいた需要を計算する
 * @param {number} populationDensity 人口密度 (人/km²)
 * @returns {{passenger: number, freight: number}} 月間需要
 */
function calculateDemandFromPopulationDensity(populationDensity) {
    // 旅客需要: 人口密度 (人/km²) を基に、駅の月間需要を計算
    const catchmentAreaKm2 = 2;
    const monthlyUseRate = 0.01;
    
    let localPopulation = populationDensity * catchmentAreaKm2;
    
    // 旅客需要: 推定人口 * 月間利用率 * ランダム性
    const passengerBase = Math.round(localPopulation * monthlyUseRate * (0.8 + Math.random() * 0.4)); // 0.8～1.2倍のランダム性
    
    // 貨物需要: 旅客需要の約1/10 (地域産業の規模を反映)
    const freightBase = Math.round(passengerBase * 0.1 * (0.8 + Math.random() * 0.4));
    
    // 最低需要を保証
    const passengerDemand = Math.max(50, passengerBase);
    const freightDemand = Math.max(10, freightBase);
    
    return {
        passenger: passengerDemand,
        freight: freightDemand,
    };
}


// ... (generateRegionalStationName, ServerStation, ServerVehicle, ServerLineManagerなどの定義は省略 - 変更なし)
async function getAddressFromCoords(lat, lng) {
    // OpenStreetMap Nominatim API (逆ジオコーディング)
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=ja&zoom=16`;
    
    try {
        const response = await axios.get(url, {
            headers: { "User-Agent": "RailwayTycoonGameServer/1.0 (Contact: your-email@example.com)" } 
        });
        
        const data = response.data;
        
        if (data.address) {
            const address = data.address;
            
            // 優先度の高い地名を取得 (駅名生成用)
            let stationNameCandidate;
            if (address.neighbourhood) stationNameCandidate = address.neighbourhood;
            else if (address.suburb) stationNameCandidate = address.suburb;
            else if (address.city_district) stationNameCandidate = address.city_district;
            else if (address.town) stationNameCandidate = address.town;
            else if (address.village) stationNameCandidate = address.village;
            else if (address.city) stationNameCandidate = address.city;
            else if (address.county) stationNameCandidate = address.county;
            else stationNameCandidate = data.display_name.split(',')[0].trim();

            return {
                stationNameCandidate: stationNameCandidate,
            };
        }
        return null;
    } catch (error) {
        console.error("Error fetching address from Nominatim:", error.message);
        return { stationNameCandidate: null };
    }
}

async function generateRegionalStationName(lat, lng) {
    const addressData = await getAddressFromCoords(lat, lng);
    
    if (addressData && addressData.stationNameCandidate) {
        let regionalName = addressData.stationNameCandidate;
        
        let baseName = regionalName.replace(/通り|公園|広場|交差点|ビル|マンション|アパート|[一二三四五六七八九十]丁目|番地|日本|Japan/g, '').trim();
        
        if (baseName.endsWith("駅")) {
            return baseName;
        }
        
        if (baseName.length > 10) {
            baseName = baseName.substring(0, 10);
        }
        
        return `${baseName}駅`;
    }
    
    // 最終フォールバック
    const randomAreas = ["新興", "郊外", "住宅", "公園", "中央", "東", "西", "南", "北"];
    const randomSuffixes = ["台", "丘", "本", "前", "野", "ヶ原"];
    const area = randomAreas[Math.floor(Math.random() * randomAreas.length)];
    const suffix = randomSuffixes[Math.floor(Math.random() * randomSuffixes.length)];
    
    return `${area}${suffix}駅`;
}

class ServerStation {
    constructor(id, latlng, ownerId, type = 'Small', initialName = null, initialDemand = null) {
        this.id = id;
        this.latlng = latlng;
        this.ownerId = ownerId;
        this.name = initialName || `仮駅名 ${id}`; 
        this.demand = initialDemand || { 
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
// ... (ServerVehicle, ServerLineManager, ゲームロジック関数は省略 - 変更なし)
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
    if (distanceKm === 0) return { cost: 0, lengthKm: 0 };
    const lengthM = distanceKm * 1000;
    const elev1 = getElevation(coord1[0], coord1[1]);
    const elev2 = getElevation(coord2[0], coord2[1]);
    const elevationDiff = Math.abs(elev1 - elev2);
    let baseCost = distanceKm * 2500000;
    
    if (trackType === 'double') baseCost *= 1.8;
    else if (trackType === 'linear') baseCost *= 5.0; 
    else if (trackType === 'tram') baseCost *= 0.8; 
    
    const slope = elevationDiff / lengthM;
    let slopeMultiplier = 1;
    if (slope > 0.1) slopeMultiplier = Math.pow(slope * 15, 3);
    else if (slope > 0.05) slopeMultiplier = Math.pow(slope * 10, 2);
    else if (slope > 0.03) slopeMultiplier = slope * 5;
    
    const slopeCost = slopeMultiplier * 500000 * lengthM; 
    const highElevationCost = Math.max(0, (elev1 + elev2) / 2 - 100) * 5000;
    const totalCost = baseCost + slopeCost + highElevationCost;
    return { cost: Math.round(totalCost), lengthKm: distanceKm };
}

// ... (ServerGame, DB操作関数、ゲームロジック関数は省略 - 変更なし)
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
    },
    VehicleData: VehicleData,
};
async function saveGlobalStats() {
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
        if (line) {
            const data = VehicleData[row.dataKey];
            const vehicle = new ServerVehicle(row.id, line, data);
            
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

async function renameStation(userId, stationId, newName) {
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
    }
    ServerGame.globalStats.lastMonthlyMaintenance = totalCost;
}

async function calculateRanking() {
    const allUsers = await UserModel.find({}).lean();
    
    const rankingPromises = allUsers.map(async (user) => {
        const totalConstructionCost = user.totalConstructionCost;
        const vehicleCount = await VehicleModel.countDocuments({ ownerId: user.userId });
        
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
        const purchaseCost = VEHICLE_BASE_COST * v.data.purchaseMultiplier;
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
    }
    
    const trainPositions = [];
    const usersToUpdateFinancials = []; 
    
    Object.values(ServerGame.users).forEach(user => {
        user.establishedLines.forEach(line => {
            line.runSimulation(gameDeltaSeconds); 
        });
        
        user.vehicles.forEach(v => {
            trainPositions.push({
                id: v.id,
                owner: user.userId,
                latlng: [v.currentLat, v.currentLng], 
                color: v.data.color,
                status: v.status // 状態をクライアントに送信
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
                vehicles: user.vehicles.map(v => ({ id: v.id, data: v.data })), 
            });
        }
    });

    io.emit('gameUpdate', {
        time: gameTime.toISOString(),
        trainPositions: trainPositions,
        globalStats: {
            timeScale: ServerGame.globalStats.timeScale,
            stationsCount: ServerGame.globalStats.stations.length,
            lastMonthlyMaintenance: ServerGame.globalStats.lastMonthlyMaintenance,
        }
    });
    
    io.emit('rankingUpdate', await calculateRanking()); 
}
// =================================================================
// D. ExpressとSocket.IOのセットアップ
// =================================================================
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'))); // publicフォルダにindex.htmlを配置
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
            establishedLines: clientLines, 
            allLines: allClientLines, 
            vehicles: userState.vehicles.map(v => ({ id: v.id, data: v.data })), 
            stations: ServerGame.globalStats.stations.map(s => ({ 
                id: s.id, latlng: [s.lat, s.lng], ownerId: s.ownerId, type: s.type, capacity: s.capacity, name: s.name, demand: s.demand 
            })), 
            vehicleData: ServerGame.VehicleData,
        });
        
        // ★追加: チャット履歴をロードして送信 (最新の50件)
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
    
    // ★変更: buildStationを非同期に変更
    socket.on('buildStation', async (data) => {
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
            
            // ★変更: 駅名と人口エリアを非同期で取得
            const newStationName = await generateRegionalStationName(latlng[0], latlng[1]);
            
            // ★変更: GeoTIFFから人口密度を取得し、需要を計算
            const populationDensity = await getPopulationDensityFromCoords(latlng[0], latlng[1]);
            const calculatedDemand = calculateDemandFromPopulationDensity(populationDensity);
            
            const newStation = new ServerStation(stationId, latlng, userId, 'Small', newStationName, calculatedDemand); 
            
            await StationModel.create({
                id: newStation.id,
                ownerId: newStation.ownerId,
                lat: latlng[0],
                lng: latlng[1],
                name: newStation.name, 
                demand: newStation.demand, // ★変更: 計算された需要を保存
                lineConnections: newStation.lineConnections,
                type: newStation.type, 
                capacity: newStation.capacity 
            });

            user.money -= STATION_COST;
            ServerGame.globalStats.stations.push(newStation);
            
            await saveUserFinancials(user.userId, user.money, user.totalConstructionCost);
            
            // ★変更: demandを追加
            io.emit('stationBuilt', { 
                latlng: data.latlng, id: newStation.id, ownerId: userId, type: newStation.type, capacity: newStation.capacity, name: newStation.name, demand: newStation.demand 
            });
            socket.emit('updateUserState', { 
                money: user.money,
                vehicles: user.vehicles.map(v => ({ id: v.id, data: v.data })), 
            });
        } catch (error) {
            console.error("buildStation error:", error);
            socket.emit('error', '駅の建設中にエラーが発生しました。');
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
                vehicles: user.vehicles.map(v => ({ id: v.id, data: v.data })), 
            });
            socket.emit('info', result.message);
        } else {
            socket.emit('error', result.message);
        }
    });
    
    // ★変更: 駅リネームイベントハンドラ
    socket.on('renameStation', async (data) => {
        if (!userId) return;
        
        const result = await renameStation(userId, data.stationId, data.newName);
        
        if (result.success) {
            // 全クライアントに駅名変更を通知
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
        
        const lineColor = LINE_COLORS[lineId % LINE_COLORS.length];
        
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
                vehicles: user.vehicles.map(v => ({ id: v.id, data: v.data })), 
            });
        } catch (error) {
            console.error("buildLine error:", error);
            socket.emit('error', '路線の建設中にエラーが発生しました。');
        }
    });
    socket.on('buyVehicle', async (data) => {
        if (!userId) return;
        
        const user = ServerGame.users[userId];
        const line = user.establishedLines.find(l => l.id == data.lineId);
        
        if (line) {
            const result = await line.addVehicle(data.vehicleKey); 
            if (result.success) {
                socket.emit('updateUserState', {
                    money: user.money,
                    vehicles: user.vehicles.map(v => ({ id: v.id, data: v.data })),
                });
            } else {
                socket.emit('error', `車両購入失敗: ${result.message}`);
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
                establishedLines: user.establishedLines.map(l => ({ id: l.id, ownerId: l.ownerId, coords: l.coords, color: l.color, trackType: l.trackType, cost: l.cost })),
                vehicles: user.vehicles.map(v => ({ id: v.id, data: v.data })),
            });
            socket.emit('info', result.message);
        } else {
            socket.emit('error', result.message);
        }
    });
    socket.on('dismantleStation', async (data) => {
        if (!userId) return;
        
        const result = await dismantleStation(userId, data.stationId); 
        
        if (result.success) {
            io.emit('stationDismantled', { stationId: result.stationId, ownerId: userId });
            
            const user = ServerGame.users[userId];
            socket.emit('updateUserState', {
                money: user.money,
                totalConstructionCost: user.totalConstructionCost,
                vehicles: user.vehicles.map(v => ({ id: v.id, data: v.data })),
            });
            socket.emit('info', result.message);
        } else {
            socket.emit('error', result.message);
        }
    });
    
    // ★追加: チャットメッセージの送信
    socket.on('sendMessage', async (data) => {
        if (!userId || !data.message || data.message.trim() === '') return;
        
        const message = data.message.trim().substring(0, 200); // 200文字に制限
        
        try {
            const chatMessage = await ChatModel.create({
                userId: userId,
                message: message,
                timestamp: new Date()
            });
            
            // 全クライアントに新しいメッセージをブロードキャスト
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
async function initializeDatabase() {
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
        
        const station = new ServerStation(
            row.id, 
            [row.lat, row.lng], 
            row.ownerId, 
            row.type || 'Small', 
            stationName,
            row.demand
        ); 
        station.demand = row.demand; 
        station.lineConnections = row.lineConnections;
        station.capacity = station.getCapacityByType(station.type); 
        return station;
    });
    
    // ★変更: 既存の仮駅名を持つ駅に対して、非同期で地名を取得し更新
    const updatePromises = ServerGame.globalStats.stations
        .filter(s => s.name.startsWith("仮駅名"))
        .map(async (station) => {
            const newName = await generateRegionalStationName(station.lat, station.lng);
            
            // GeoTIFFから人口密度を取得し、需要を再計算
            const populationDensity = await getPopulationDensityFromCoords(station.lat, station.lng);
            const newDemand = calculateDemandFromPopulationDensity(populationDensity);
            
            if (newName !== station.name || JSON.stringify(newDemand) !== JSON.stringify(station.demand)) {
                station.name = newName;
                station.demand = newDemand;
                await StationModel.updateOne({ id: station.id }, { $set: { name: newName, demand: newDemand } });
                console.log(`既存の仮駅名 ${station.id} を ${newName} に更新し、需要を再計算しました。`);
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
        await loadPopulationTiff(); // ★ GeoTIFFのロード
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
