// server.js

const express = require("express");
const http = require("http");
const socketio = require("socket.io");
const cookieParser = require("cookie-parser");
const path = require("path");
const turf = require("@turf/turf");

const app = express();
const server = http.createServer(app);
const io = socketio(server);

const PORT = 3000;

// =================================================================
// A. サーバーサイド・ゲーム定数とユーティリティ
// =================================================================
const STATION_COST = 50000000;
const VEHICLE_BASE_COST = 8000000;
const LINE_COLORS = [
  "#E4007F",
  "#009933",
  "#0000FF",
  "#FFCC00",
  "#FF6600",
  "#9900CC",
];

const VehicleData = {
  COMMUTER: {
    name: "通勤形",
    maxSpeedKmH: 100,
    capacity: 500,
    maintenanceCostPerKm: 400,
    type: "passenger",
    color: "#008000",
    purchaseMultiplier: 1.0,
  },
  EXPRESS: {
    name: "優等形",
    maxSpeedKmH: 160,
    capacity: 600,
    maintenanceCostPerKm: 700,
    type: "passenger",
    color: "#FF0000",
    purchaseMultiplier: 1.5,
  },
  SHINKANSEN: {
    name: "新幹線",
    maxSpeedKmH: 300,
    capacity: 1000,
    maintenanceCostPerKm: 1500,
    type: "passenger",
    color: "#00BFFF",
    purchaseMultiplier: 5.0,
  },
  LINEAR: {
    name: "リニア",
    maxSpeedKmH: 500,
    capacity: 800,
    maintenanceCostPerKm: 3000,
    type: "passenger",
    color: "#FF00FF",
    purchaseMultiplier: 10.0,
  },
  LOCAL_FREIGHT: {
    name: "地方貨物",
    maxSpeedKmH: 75,
    capacity: 1500,
    maintenanceCostPerKm: 300,
    type: "freight",
    color: "#8B4513",
    purchaseMultiplier: 1.2,
  },
  HIGH_SPEED_FREIGHT: {
    name: "高速貨物",
    maxSpeedKmH: 120,
    capacity: 1000,
    maintenanceCostPerKm: 500,
    type: "freight",
    color: "#A0522D",
    purchaseMultiplier: 2.0,
  },
  SLEEPER: {
    name: "寝台列車",
    maxSpeedKmH: 110,
    capacity: 200,
    maintenanceCostPerKm: 800,
    type: "passenger",
    color: "#4B0082",
    purchaseMultiplier: 3.0,
    revenueMultiplier: 2.0,
  },
  TRAM: {
    name: "路面電車",
    maxSpeedKmH: 50,
    capacity: 150,
    maintenanceCostPerKm: 100,
    type: "passenger",
    color: "#808080",
    purchaseMultiplier: 0.5,
  },
};

// 簡易ユーザーデータベース (メモリ内)
const USER_PASSWORDS = {}; // { username: password }

function getElevation(lat, lng) {
  const TOKYO_BAY_LAT = 35.6;
  const TOKYO_BAY_LNG = 139.7;
  const tokyoDist = Math.sqrt(
    (lat - TOKYO_BAY_LAT) ** 2 + (lng - TOKYO_BAY_LNG) ** 2
  );
  let elevation = 100 * Math.exp(-tokyoDist * 5) + Math.random() * 5;
  if (lng < 139.7) {
    elevation += 10 + (139.7 - lng) * 50;
  }
  if (lat < 35.6) {
    elevation += 10 + (35.6 - lat) * 50;
  }
  return Math.round(Math.min(3000, Math.max(0, elevation)));
}

function getDistanceKm(coord1, coord2) {
  const lngLat1 = [coord1[1], coord1[0]];
  const lngLat2 = [coord2[1], coord2[0]];
  return turf.distance(turf.point(lngLat1), turf.point(lngLat2), {
    units: "kilometers",
  });
}

function calculateConstructionCost(coord1, coord2, trackType) {
  const distanceKm = getDistanceKm(coord1, coord2);
  if (distanceKm === 0) return { cost: 0, lengthKm: 0 };
  const lengthM = distanceKm * 1000;

  const elev1 = getElevation(coord1[0], coord1[1]);
  const elev2 = getElevation(coord2[0], coord2[1]);
  const elevationDiff = Math.abs(elev1 - elev2);

  let baseCost = distanceKm * 2500000;

  if (trackType === "double") baseCost *= 1.8;
  else if (trackType === "linear") baseCost *= 5.0;
  else if (trackType === "tram") baseCost *= 0.8;

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
  constructor(id, latlng, ownerId) {
    this.id = id;
    this.latlng = latlng;
    this.ownerId = ownerId;
    this.name = `駅 ${id}`;
    this.demand = {
      passenger: Math.round(50 + Math.random() * 300),
      freight: Math.round(10 + Math.random() * 100),
    };
    this.lineConnections = [];
  }
  addLine(lineId) {
    if (!this.lineConnections.includes(lineId)) {
      this.lineConnections.push(lineId);
    }
  }
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
    this.status = "Running";
    this.isReversed = false;
    this.stopTimer = 0;
    this.currentLat = this.coords[0][0];
    this.currentLng = this.coords[0][1];

    this.totalRouteKm = [0];
    for (let i = 1; i < this.coords.length; i++) {
      const segmentKm = getDistanceKm(this.coords[i - 1], this.coords[i]);
      this.totalRouteKm.push(this.totalRouteKm[i - 1] + segmentKm);
    }
    this.routeLength = this.totalRouteKm[this.totalRouteKm.length - 1];
  }

  move(gameDeltaSeconds) {
    if (this.status === "Stopping") {
      this.stopTimer -= gameDeltaSeconds;
      if (this.stopTimer <= 0) {
        this.status = "Running";
      }
      return;
    }
    if (this.status !== "Running") return;

    const speedKms = this.data.maxSpeedKmH / 3600;
    const travelDistanceKm = speedKms * gameDeltaSeconds;

    const direction = this.isReversed ? -1 : 1;
    this.positionKm += travelDistanceKm * direction;

    if (this.positionKm >= this.routeLength) {
      this.positionKm = this.routeLength;
      this.isReversed = true;
      this.handleStationArrival(this.stations[this.stations.length - 1]);
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

    let idx = this.totalRouteKm.findIndex((km) => km > targetKm);
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

    this.stations.forEach((station, index) => {
      const stationKm = this.totalRouteKm[index];

      if (
        Math.abs(this.positionKm - stationKm) < arrivalTolerance &&
        this.status === "Running"
      ) {
        this.handleStationArrival(station);
      }
    });
  }

  handleStationArrival(station) {
    this.status = "Stopping";
    this.stopTimer = 30;

    let revenue = 0;
    const revenueMultiplier = this.data.revenueMultiplier || 1.0;

    if (this.data.type === "passenger") {
      revenue =
        ((station.demand.passenger * this.data.capacity) / 100) *
        5000 *
        revenueMultiplier;
    } else if (this.data.type === "freight") {
      revenue =
        ((station.demand.freight * this.data.capacity) / 500) *
        2000 *
        revenueMultiplier;
    }

    const stationsAtLocation = ServerGame.globalStats.stations.filter(
      (s) =>
        s.latlng[0] === station.latlng[0] && s.latlng[1] === station.latlng[1]
    );

    const totalConnections = stationsAtLocation.flatMap(
      (s) => s.lineConnections
    ).length;

    revenue *= 1 + Math.min(1.0, totalConnections * 0.1);

    if (ServerGame.users[this.ownerId]) {
      ServerGame.users[this.ownerId].money += Math.round(revenue);
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

  addVehicle(vehicleKey) {
    const data = VehicleData[vehicleKey];
    const purchaseCost = VEHICLE_BASE_COST * data.purchaseMultiplier;

    const user = ServerGame.users[this.ownerId];
    if (!user || user.money < purchaseCost) {
      return { success: false, message: "資金不足" };
    }

    const isLinear = data.name === "リニア";

    if (isLinear && this.trackType !== "linear") {
      return { success: false, message: "リニアは専用線路が必要です" };
    }
    if (!isLinear && this.trackType === "linear") {
      return {
        success: false,
        message: "リニア線路にはリニア以外配置できません",
      };
    }

    user.money -= purchaseCost;

    const vehicleId = ServerGame.globalStats.nextVehicleId++;
    const newVehicle = new ServerVehicle(vehicleId, this, data);
    this.vehicles.push(newVehicle);
    user.vehicles.push(newVehicle);
    return { success: true, vehicle: newVehicle };
  }

  runSimulation(gameDeltaSeconds) {
    this.vehicles.forEach((v) => v.move(gameDeltaSeconds));
  }
}

// =================================================================
// C. サーバーサイド・ゲーム状態管理
// =================================================================

const ServerGame = {
  users: {},
  globalStats: {
    gameTime: new Date(2025, 0, 1, 0, 0, 0),
    timeScale: 3600,
    stations: [],
    lastMonthlyMaintenance: 0,
    nextStationId: 1,
    nextLineId: 1,
    nextVehicleId: 1,
  },
  VehicleData: VehicleData,
};

function calculateMonthlyMaintenance() {
  let totalCost = 0;
  Object.values(ServerGame.users).forEach((user) => {
    let monthlyMaintenance = 0;

    user.establishedLines.forEach((line) => {
      monthlyMaintenance += line.cost * 0.002;
    });

    user.vehicles.forEach((vehicle) => {
      monthlyMaintenance += vehicle.data.maintenanceCostPerKm * 1000;
    });

    const userCost = Math.round(monthlyMaintenance);
    user.money -= userCost;
    totalCost += userCost;
  });
  ServerGame.globalStats.lastMonthlyMaintenance = totalCost;
}

function calculateRanking() {
  const ranking = Object.values(ServerGame.users)
    .map((user) => ({
      userId: user.userId,
      score:
        user.money +
        user.totalConstructionCost * 0.7 +
        user.vehicles.length * 10000000,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  return ranking;
}

function dismantleLine(userId, lineId) {
  const user = ServerGame.users[userId];
  if (!user) return { success: false, message: "ユーザーが見つかりません。" };

  const lineIndex = user.establishedLines.findIndex((l) => l.id === lineId);
  if (lineIndex === -1)
    return { success: false, message: "路線が見つかりません。" };

  const lineToDismantle = user.establishedLines[lineIndex];

  // 1. 解体費用 (建設費用の10%)
  const dismantleCost = Math.round(lineToDismantle.cost * 0.1);
  if (user.money < dismantleCost)
    return { success: false, message: "解体費用が不足しています。" };

  user.money -= dismantleCost;

  // 2. 路線上の車両を売却 (購入価格の1/3)
  let totalVehicleSaleRevenue = 0;

  const vehiclesOnLine = user.vehicles.filter((v) => v.lineId === lineId);

  vehiclesOnLine.forEach((v) => {
    const purchaseCost = VEHICLE_BASE_COST * v.data.purchaseMultiplier;
    const saleRevenue = Math.round(purchaseCost / 3);
    user.money += saleRevenue;
    totalVehicleSaleRevenue += saleRevenue;
  });

  user.vehicles = user.vehicles.filter((v) => v.lineId !== lineId);

  // 3. 路線を削除
  user.establishedLines.splice(lineIndex, 1);
  user.totalConstructionCost -= lineToDismantle.cost;

  // 4. 駅の接続情報からこの路線IDを削除
  lineToDismantle.stations.forEach((station) => {
    const globalStation = ServerGame.globalStats.stations.find(
      (s) => s.id === station.id
    );
    if (globalStation) {
      globalStation.lineConnections = globalStation.lineConnections.filter(
        (id) => id !== lineId
      );
    }
  });

  return {
    success: true,
    message: `路線 ${lineId} を解体しました。車両売却収益: ¥${totalVehicleSaleRevenue.toLocaleString()}`,
    lineId: lineId,
    dismantleCost: dismantleCost,
  };
}

function dismantleStation(userId, stationId) {
  const user = ServerGame.users[userId];
  if (!user) return { success: false, message: "ユーザーが見つかりません。" };

  const globalStationIndex = ServerGame.globalStats.stations.findIndex(
    (s) => s.id === stationId && s.ownerId === userId
  );
  if (globalStationIndex === -1)
    return { success: false, message: "あなたの駅が見つかりません。" };

  const stationToDismantle =
    ServerGame.globalStats.stations[globalStationIndex];

  // 1. 接続路線のチェック
  if (stationToDismantle.lineConnections.length > 0) {
    return {
      success: false,
      message:
        "この駅には路線が接続されています。先に路線をすべて解体してください。",
    };
  }

  // 2. 解体費用 (建設費用の10%)
  const dismantleCost = Math.round(STATION_COST * 0.1);
  if (user.money < dismantleCost)
    return { success: false, message: "解体費用が不足しています。" };

  user.money -= dismantleCost;

  // 3. 駅を削除
  ServerGame.globalStats.stations.splice(globalStationIndex, 1);

  return {
    success: true,
    message: `駅 ${stationId} を解体しました。`,
    stationId: stationId,
    dismantleCost: dismantleCost,
  };
}

let lastSimTime = performance.now();
function serverSimulationLoop() {
  const currentTime = performance.now();
  const deltaTimeMs = currentTime - lastSimTime;
  lastSimTime = currentTime;

  const gameDeltaSeconds =
    (deltaTimeMs / 1000) * ServerGame.globalStats.timeScale;

  const gameTime = ServerGame.globalStats.gameTime;
  const prevMonth = gameTime.getMonth();
  gameTime.setTime(
    gameTime.getTime() + deltaTimeMs * ServerGame.globalStats.timeScale
  );
  const nowMonth = gameTime.getMonth();
  if (nowMonth !== prevMonth) {
    calculateMonthlyMaintenance();
  }

  const trainPositions = [];
  Object.values(ServerGame.users).forEach((user) => {
    user.establishedLines.forEach((line) => {
      line.runSimulation(gameDeltaSeconds);
    });

    user.vehicles.forEach((v) => {
      trainPositions.push({
        id: v.id,
        owner: user.userId,
        latlng: [v.currentLat, v.currentLng],
        color: v.data.color,
      });
    });
  });

  io.emit("gameUpdate", {
    time: gameTime.toISOString(),
    trainPositions: trainPositions,
    globalStats: {
      timeScale: ServerGame.globalStats.timeScale,
      stationsCount: ServerGame.globalStats.stations.length,
      lastMonthlyMaintenance: ServerGame.globalStats.lastMonthlyMaintenance,
    },
  });

  io.emit("rankingUpdate", calculateRanking());
}

setInterval(serverSimulationLoop, 100);

// =================================================================
// D. ExpressとSocket.IOのセットアップ
// =================================================================

app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

app.post("/login", express.json(), (req, res) => {
  const { username, password } = req.body;

  if (!username || username.length < 3 || !password) {
    return res
      .status(400)
      .send({ message: "ユーザー名とパスワードを入力してください。" });
  }

  if (USER_PASSWORDS[username]) {
    // 既存ユーザーのログイン
    if (USER_PASSWORDS[username] !== password) {
      return res.status(401).send({ message: "パスワードが違います。" });
    }
  } else {
    // 新規ユーザー登録
    USER_PASSWORDS[username] = password;
    console.log(`新規ユーザー登録: ${username}`);
  }

  res.cookie("userId", username, {
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
  });
  res.send({ success: true, userId: username });
});

io.on("connection", (socket) => {
  let userId = null;

  socket.on("login", (data) => {
    userId = data.userId;
    if (!userId) return;

    if (!ServerGame.users[userId]) {
      ServerGame.users[userId] = {
        socketId: socket.id,
        userId: userId,
        money: 5000000000,
        establishedLines: [],
        vehicles: [],
        totalConstructionCost: 0,
      };
    } else {
      ServerGame.users[userId].socketId = socket.id;
    }

    const userState = ServerGame.users[userId];
    const clientLines = userState.establishedLines.map((line) => ({
      id: line.id,
      ownerId: line.ownerId,
      coords: line.coords,
      color: line.color,
      trackType: line.trackType,
    }));

    socket.emit("initialState", {
      money: userState.money,
      totalConstructionCost: userState.totalConstructionCost,
      establishedLines: clientLines,
      vehicles: userState.vehicles.map((v) => ({ id: v.id, data: v.data })),
      stations: ServerGame.globalStats.stations.map((s) => ({
        id: s.id,
        latlng: s.latlng,
        ownerId: s.ownerId,
      })),
      vehicleData: ServerGame.VehicleData,
    });
  });

  socket.on("buildStation", (data) => {
    if (!userId || ServerGame.users[userId].money < STATION_COST) {
      socket.emit("error", "資金不足で駅を建設できません。");
      return;
    }

    const latlng = [data.latlng.lat, data.latlng.lng];
    const newStation = new ServerStation(
      ServerGame.globalStats.nextStationId++,
      latlng,
      userId
    );

    ServerGame.users[userId].money -= STATION_COST;
    ServerGame.globalStats.stations.push(newStation);

    io.emit("stationBuilt", {
      latlng: data.latlng,
      id: newStation.id,
      ownerId: userId,
    });
    socket.emit("updateUserState", { money: ServerGame.users[userId].money });
  });

  socket.on("buildLine", (data) => {
    if (!userId || data.stationCoords.length < 2) return;

    const user = ServerGame.users[userId];
    const lineId = ServerGame.globalStats.nextLineId++;
    const lineColor = LINE_COLORS[lineId % LINE_COLORS.length];

    let totalCost = 0;
    let totalLengthKm = 0;

    for (let i = 1; i < data.stationCoords.length; i++) {
      const { cost: segCost, lengthKm: segLength } = calculateConstructionCost(
        data.stationCoords[i - 1],
        data.stationCoords[i],
        data.trackType
      );
      totalCost += segCost;
      totalLengthKm += segLength;
    }

    if (user.money < totalCost) {
      socket.emit(
        "error",
        `資金不足です！線路建設費用: ¥${totalCost.toLocaleString()}`
      );
      return;
    }

    user.money -= totalCost;
    user.totalConstructionCost += totalCost;

    const lineStations = data.stationCoords
      .map((coord) =>
        ServerGame.globalStats.stations.find(
          (s) => s.latlng[0] === coord[0] && s.latlng[1] === coord[1]
        )
      )
      .filter((s) => s);

    const newLineManager = new ServerLineManager(
      lineId,
      userId,
      lineStations,
      data.stationCoords,
      totalCost,
      totalLengthKm,
      lineColor,
      data.trackType
    );

    user.establishedLines.push(newLineManager);
    lineStations.forEach((station) => station.addLine(lineId));

    io.emit("lineBuilt", {
      ownerId: userId,
      id: lineId,
      coords: data.stationCoords,
      color: lineColor,
      trackType: data.trackType,
      cost: totalCost,
      lengthKm: totalLengthKm,
    });
    socket.emit("updateUserState", {
      money: user.money,
      totalConstructionCost: user.totalConstructionCost,
    });
  });

  socket.on("buyVehicle", (data) => {
    if (!userId) return;

    const user = ServerGame.users[userId];
    const line = user.establishedLines.find((l) => l.id == data.lineId);

    if (line) {
      const result = line.addVehicle(data.vehicleKey);
      if (result.success) {
        socket.emit("updateUserState", {
          money: user.money,
          vehicles: user.vehicles.map((v) => ({ id: v.id, data: v.data })),
        });
      } else {
        socket.emit("error", `車両購入失敗: ${result.message}`);
      }
    }
  });

  socket.on("dismantleLine", (data) => {
    if (!userId) return;

    const result = dismantleLine(userId, data.lineId);

    if (result.success) {
      io.emit("lineDismantled", { lineId: result.lineId, ownerId: userId });

      const user = ServerGame.users[userId];
      socket.emit("updateUserState", {
        money: user.money,
        totalConstructionCost: user.totalConstructionCost,
        establishedLines: user.establishedLines.map((l) => ({
          id: l.id,
          ownerId: l.ownerId,
          coords: l.coords,
          color: l.color,
          trackType: l.trackType,
        })),
        vehicles: user.vehicles.map((v) => ({ id: v.id, data: v.data })),
      });
      socket.emit("info", result.message);
    } else {
      socket.emit("error", result.message);
    }
  });

  socket.on("dismantleStation", (data) => {
    if (!userId) return;

    const result = dismantleStation(userId, data.stationId);

    if (result.success) {
      io.emit("stationDismantled", {
        stationId: result.stationId,
        ownerId: userId,
      });

      const user = ServerGame.users[userId];
      socket.emit("updateUserState", {
        money: user.money,
        totalConstructionCost: user.totalConstructionCost,
      });
      socket.emit("info", result.message);
    } else {
      socket.emit("error", result.message);
    }
  });

  socket.on("disconnect", () => {
    // ...
  });
});

server.listen(PORT, () => {
  console.log(`サーバーがポート ${PORT} で起動しました。`);
});
