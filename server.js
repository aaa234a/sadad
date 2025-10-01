// server.js
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const cookieParser = require('cookie-parser');
const path = require('path');
const turf = require('@turf/turf'); 
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000; 
const server = http.createServer(app);
const io = socketio(server);

// =================================================================
// 0. データベース接続とMongooseスキーマ定義
// =================================================================

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

// =================================================================
// A. サーバーサイド・ゲーム定数とユーティリティ
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
// =================================================================
// B. サーバーサイド・クラス定義
// =================================================================
class ServerStation {
    constructor(id, latlng, ownerId, type = 'Small') {
        this.id = id;
        this.latlng = latlng;
        this.ownerId = ownerId;
        this.name = `駅 ${id}`;
        this.demand = { 
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
    constructor(id, line, data) {
        this.id = id;
        this.lineId = line.id;
        this.ownerId = line.ownerId;
        this.data = data;
        this.coords = line.coords;
        this.stations = line.stations; 
        
        this.positionKm = 0; 
        this.status = 'Running'; 
        this.isReversed = false; 
        this.stopTimer = 0; 
        this.currentLat = this.coords[0][0];
        this.currentLng = this.coords[0][1];
        this.waitingForStationKm = -1; 

        this.totalRouteKm = [0];
        for(let i = 1; i < this.coords.length; i++) {
            const segmentKm = getDistanceKm(this.coords[i-1], this.coords[i]);
            this.totalRouteKm.push(this.totalRouteKm[i-1] + segmentKm);
        }
        this.routeLength = this.totalRouteKm[this.totalRouteKm.length - 1];
    }

    getStationKm(station) {
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
        
        let nextStation = null;
        let minDistance = Infinity;
        
        this.stations.forEach(station => {
            const stationKm = this.getStationKm(station);
            if (stationKm === -1) return;
            
            const distance = this.isReversed ? this.positionKm - stationKm : stationKm - this.positionKm;
            
            if (distance > 0 && distance < minDistance) {
                nextStation = station;
                minDistance = distance;
            }
        });
        
        const safetyDistance = 0.5; // 500メートル手前でチェック

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
    
    handleStationArrival(station) {
        station.occupyingVehicles.add(this.id);
        
        this.status = 'Stopping';
        this.stopTimer = 30; 
        let revenue = 0;
        const revenueMultiplier = this.data.revenueMultiplier || 1.0;
        
        // 収益を約半分に減らす (5000 -> 2500, 2000 -> 1000)
        if (this.data.type === 'passenger') {
            revenue = station.demand.passenger * this.data.capacity / 100 * 2500 * revenueMultiplier; 
        } else if (this.data.type === 'freight') {
            revenue = station.demand.freight * this.data.capacity / 500 * 1000 * revenueMultiplier;
        }
        const stationsAtLocation = ServerGame.globalStats.stations.filter(s => 
            s.latlng[0] === station.latlng[0] && s.latlng[1] === station.latlng[1]
        );
        
        const totalConnections = stationsAtLocation.flatMap(s => s.lineConnections).length;
        
        revenue *= (1 + Math.min(1.0, totalConnections * 0.1)); 
        if (ServerGame.users[this.ownerId]) {
            ServerGame.users[this.ownerId].money += Math.round(revenue);
            ServerGame.users[this.ownerId].moneyUpdated = true; 
        }
    }
}
class ServerLineManager {
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
        allLines: [], 
        lastMonthlyMaintenance: 0,
        nextStationId: 1,
        nextLineId: 1,
        nextVehicleId: 1,
    },
    VehicleData: VehicleData,
};
// =================================================================
// C-1. DB操作関数 (Mongoose)
// =================================================================
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
        message: `駅 ${stationId} を解体しました。`,
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
                id: s.id, latlng: [s.lat, s.lng], ownerId: s.ownerId, type: s.type, capacity: s.capacity 
            })), 
            vehicleData: ServerGame.VehicleData,
        });
    });
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
            
            const newStation = new ServerStation(stationId, latlng, userId, 'Small'); 
            
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
                latlng: data.latlng, id: newStation.id, ownerId: userId, type: newStation.type, capacity: newStation.capacity 
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
        const station = new ServerStation(row.id, [row.lat, row.lng], row.ownerId, row.type || 'Small');
        station.name = row.name;
        station.demand = row.demand;
        station.lineConnections = row.lineConnections;
        station.capacity = station.getCapacityByType(station.type); 
        return station;
    });
    
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
