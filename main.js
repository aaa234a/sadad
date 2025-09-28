// =========================================================
// A. ゲーム定数と状態 (クライアント側)
// =========================================================
const SERVER_URL = "https://970b785c5b0f.ngrok-free.app/";
const INITIAL_LAT = 35.681236;
const INITIAL_LNG = 139.767125;
const STATION_COST = 50000000;
const VEHICLE_BASE_COST = 8000000;

let VehicleData = {};
let map; // Leafletマップインスタンス

const Game = {
  userId: null,
  money: 0,
  totalConstructionCost: 0,
  establishedLines: [],
  allLines: {},
  stations: [],
  vehicles: [],
  allTrainMarkers: {},
  mode: "idle",
  currentTrackType: "single",

  updateStats(data) {
    this.money = data.money !== undefined ? data.money : this.money;
    this.totalConstructionCost =
      data.totalConstructionCost !== undefined
        ? data.totalConstructionCost
        : this.totalConstructionCost;
    this.establishedLines =
      data.establishedLines !== undefined
        ? data.establishedLines
        : this.establishedLines;
    this.vehicles = data.vehicles !== undefined ? data.vehicles : this.vehicles;

    if (data.stations) this.drawStations(data.stations);
    if (data.establishedLines) this.drawLines(data.establishedLines);

    const totalAsset =
      this.money +
      this.totalConstructionCost * 0.7 +
      this.vehicles.length * VEHICLE_BASE_COST;
    document.getElementById("money-display").textContent = `¥${Math.round(
      this.money
    ).toLocaleString()}`;
    document.getElementById("asset-display").textContent = `¥${Math.round(
      totalAsset
    ).toLocaleString()}`;
    document.getElementById("vehicle-count").textContent = this.vehicles.length;
  },

  updateGlobalStats(data) {
    const gameTime = new Date(data.time);
    document.getElementById("game-date-time").textContent =
      this.formatDateTime(gameTime);
    document.getElementById(
      "time-scale-display"
    ).textContent = `x${data.globalStats.timeScale}`;
    document.getElementById("maint-cost-display").textContent = `¥${(
      data.globalStats.lastMonthlyMaintenance || 0
    ).toLocaleString()}`;
    document.getElementById("station-count").textContent =
      data.globalStats.stationsCount;
  },

  formatDateTime(date) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hour = date.getHours().toString().padStart(2, "0");
    return `${year}年${month}月${day}日 ${hour}時`;
  },

  drawStations(stations) {
    this.stations.forEach((s) => map.removeLayer(s.marker));
    this.stations = [];
    stations.forEach(
      (s) =>
        new Station(
          s.id,
          { lat: s.latlng[0], lng: s.latlng[1] },
          map,
          s.ownerId
        )
    );
  },

  drawLines(lines) {
    Object.values(this.allLines).forEach((l) => map.removeLayer(l));
    this.allLines = {};
    lines.forEach((line) => this.drawLine(line));
  },

  drawLine(line) {
    let weight = 8;
    if (line.trackType === "double") weight = 12;
    else if (line.trackType === "linear") weight = 15;
    else if (line.trackType === "tram") weight = 6;

    const finalStyle = {
      color: line.color,
      weight: weight,
      opacity: 1,
      lineCap: "round",
    };
    this.allLines[line.id] = L.polyline(line.coords, finalStyle)
      .addTo(map)
      .bindPopup(
        `<b>Line ${line.id}</b> (${line.trackType})<br>Owner: ${line.ownerId}`
      );
  },
};

let socket;
let drawingPolyline = null;
let lineCandidateNodes = [];

class Station {
  constructor(id, latlng, map, ownerId) {
    this.id = id;
    this.latlng = latlng;
    this.ownerId = ownerId;
    this.name = `駅 ${id}`;

    const stationColor = ownerId === Game.userId ? "#0044BB" : "#FF0000";

    this.marker = L.marker(latlng, {
      icon: L.divIcon({
        className: "station-icon",
        style: `background-color: ${stationColor};`,
      }),
      title: this.name,
    }).addTo(map);

    this.marker.bindPopup(
      `<b>${this.name} (ID: ${this.id})</b><br>Owner: ${ownerId}`
    );
    this.marker.on("click", (e) => {
      if (Game.mode === "track" || Game.mode === "dismantle-station") {
        handleStationClick(this);
        L.DomEvent.stopPropagation(e);
      }
    });
    Game.stations.push(this);
  }
}

// =========================================================
// C. サーバー通信と認証
// =========================================================

function getCookie(name) {
  const nameEQ = name + "=";
  const ca = document.cookie.split(";");
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i];
    while (c.charAt(0) === " ") c = c.substring(1, c.length);
    if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
  }
  return null;
}

async function handleLogin() {
  const username = document.getElementById("username-input").value.trim();
  const password = document.getElementById("password-input").value.trim();

  if (username.length < 3 || password.length === 0) {
    alert("ユーザー名とパスワードを入力してください。");
    return;
  }

  try {
    // ★★★ ログインAPIの接続先を明示的に指定 ★★★
    const response = await fetch(`${SERVER_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 認証クッキーをクロスオリジンで送信するために必要
      credentials: "include",
      body: JSON.stringify({ username: username, password: password }),
    });
    const data = await response.json();

    if (data.success) {
      Game.userId = data.userId;
      document.getElementById("login-overlay").style.display = "none";
      connectSocket(Game.userId);
    } else {
      alert("ログイン失敗: " + data.message);
    }
  } catch (error) {
    console.error("ログインエラー:", error);
    alert("サーバーとの通信に失敗しました。");
  }
}

function connectSocket(userId) {
  // ★★★ Socket.IOの接続先を明示的に指定 ★★★
  socket = io(SERVER_URL, {
    // 認証クッキーをクロスオリジンで送信するために必要
    withCredentials: true,
  });

  socket.on("connect", () => {
    socket.emit("login", { userId: userId });
  });

  socket.on("initialState", (data) => {
    VehicleData = data.vehicleData;
    Game.updateStats(data);
    updateVehicleBuyUI();
  });

  socket.on("updateUserState", (data) => {
    Game.updateStats(data);
    updateVehicleBuyUI();
  });

  socket.on("gameUpdate", (data) => {
    Game.updateGlobalStats(data);
    updateTrainPositions(data.trainPositions);
  });

  socket.on("rankingUpdate", (ranking) => {
    updateRankingUI(ranking);
  });

  socket.on("stationBuilt", (data) => {
    new Station(data.id, data.latlng, map, data.ownerId);
  });

  socket.on("lineBuilt", (data) => {
    Game.drawLine(data);
    if (data.ownerId === Game.userId) {
      Game.establishedLines.push(data);
    }
  });

  socket.on("lineDismantled", (data) => {
    if (Game.allLines[data.lineId]) {
      map.removeLayer(Game.allLines[data.lineId]);
      delete Game.allLines[data.lineId];
    }
    if (data.ownerId === Game.userId) {
      Game.establishedLines = Game.establishedLines.filter(
        (l) => l.id !== data.lineId
      );
    }
  });

  socket.on("stationDismantled", (data) => {
    const stationIndex = Game.stations.findIndex(
      (s) => s.id === data.stationId
    );
    if (stationIndex !== -1) {
      map.removeLayer(Game.stations[stationIndex].marker);
      Game.stations.splice(stationIndex, 1);
    }
  });

  socket.on("error", (message) => {
    const errorDiv = document.getElementById("error-message");
    errorDiv.textContent = message;
    errorDiv.style.display = "block";
    setTimeout(() => {
      errorDiv.style.display = "none";
    }, 5000);
  });

  socket.on("info", (message) => {
    const infoDiv = document.getElementById("info-message");
    infoDiv.textContent = message;
    infoDiv.style.display = "block";
    setTimeout(() => {
      infoDiv.style.display = "none";
    }, 5000);
  });
}

function updateTrainPositions(trainPositions) {
  trainPositions.forEach((train) => {
    if (Game.allTrainMarkers[train.id]) {
      Game.allTrainMarkers[train.id].setLatLng(train.latlng);
    } else {
      const marker = L.divIcon({
        className: "train-icon",
        style: `background-color: ${train.color}; border-color: ${
          train.owner === Game.userId ? "yellow" : "white"
        };`,
      });
      Game.allTrainMarkers[train.id] = L.marker(train.latlng, {
        icon: marker,
      }).addTo(map);
      Game.allTrainMarkers[train.id].bindPopup(
        `列車 #${train.id} (Owner: ${train.owner})`
      );
    }
  });
}

function updateRankingUI(ranking) {
  const list = document.getElementById("ranking-list");
  list.innerHTML = "";
  ranking.forEach((item, index) => {
    const li = document.createElement("li");
    li.innerHTML = `${index + 1}. <b>${item.userId}</b>: ¥${Math.round(
      item.score
    ).toLocaleString()}`;
    if (item.userId === Game.userId) {
      li.style.fontWeight = "bold";
      li.style.color = "#0044BB";
    }
    list.appendChild(li);
  });
}

// =========================================================
// D. 建設・解体ロジック (サーバーにコマンド送信)
// =========================================================

function handleStationCreation(e) {
  if (Game.mode !== "station" || !socket) return;
  socket.emit("buildStation", { latlng: e.latlng });
}

function handleStationDismantle(station) {
  if (Game.mode !== "dismantle-station" || !socket) return;

  if (station.ownerId !== Game.userId) {
    alert("自分の駅しか解体できません。");
    return;
  }

  const dismantleCost = Math.round(STATION_COST * 0.1);
  if (
    confirm(
      `駅 ${
        station.id
      } を解体しますか？ (費用: ¥${dismantleCost.toLocaleString()})`
    )
  ) {
    socket.emit("dismantleStation", { stationId: station.id });
  }
}

function handleStationClick(station) {
  if (Game.mode === "track") {
    // 路線建設モード
    if (station.ownerId !== Game.userId) {
      alert("他プレイヤーの駅は路線のノードとして使用できません。");
      return;
    }

    if (lineCandidateNodes.includes(station)) return;

    lineCandidateNodes.push(station);

    const currentCoords = lineCandidateNodes.map((s) => [
      s.latlng.lat,
      s.latlng.lng,
    ]);

    if (currentCoords.length >= 2) {
      let weight = 7;
      if (Game.currentTrackType === "double") weight = 12;
      else if (Game.currentTrackType === "linear") weight = 15;
      else if (Game.currentTrackType === "tram") weight = 6;

      if (drawingPolyline) {
        drawingPolyline
          .setLatLngs(currentCoords)
          .setStyle({ color: "#C0C0C0", weight: weight });
      } else {
        drawingPolyline = L.polyline(currentCoords, {
          color: "#C0C0C0",
          weight: weight,
          opacity: 0.8,
          dashArray: "10, 10",
        }).addTo(map);
      }
    }
  } else if (Game.mode === "dismantle-station") {
    // 駅解体モード
    handleStationDismantle(station);
  }
}

function finalizeLine() {
  if (lineCandidateNodes.length < 2 || !socket) {
    alert("路線には2つ以上の駅が必要です。");
    return;
  }

  const stationCoords = lineCandidateNodes.map((s) => [
    s.latlng.lat,
    s.latlng.lng,
  ]);

  socket.emit("buildLine", {
    stationCoords: stationCoords,
    trackType: Game.currentTrackType,
  });

  if (drawingPolyline) map.removeLayer(drawingPolyline);
  lineCandidateNodes = [];
  drawingPolyline = null;
  toggleConstructionMode("idle");
}

function handleLineDismantle(e) {
  if (Game.mode !== "dismantle-line" || !socket) return;

  let closestLine = null;
  let minDistance = Infinity;
  const lineSearchRadiusMeters = 50; // 50m以内を許容範囲とする

  const myLines = Game.establishedLines
    .map((line) => Game.allLines[line.id])
    .filter((l) => l);

  myLines.forEach((polyline) => {
    const latlngs = polyline.getLatLngs();
    latlngs.forEach((latlng) => {
      // Leafletの距離計算はメートル単位
      const dist = e.latlng.distanceTo(latlng);
      if (dist < minDistance && dist < lineSearchRadiusMeters) {
        minDistance = dist;
        closestLine = polyline;
      }
    });
  });

  if (closestLine) {
    const lineId = Object.keys(Game.allLines).find(
      (key) => Game.allLines[key] === closestLine
    );
    const lineData = Game.establishedLines.find((l) => l.id == lineId);

    if (lineData && lineData.ownerId === Game.userId) {
      const dismantleCost = Math.round(lineData.cost * 0.1);
      if (
        confirm(
          `路線 ${lineId} を解体しますか？ (費用: ¥${dismantleCost.toLocaleString()}、車両は購入価格の1/3で自動売却されます)`
        )
      ) {
        socket.emit("dismantleLine", { lineId: parseInt(lineId) });
      }
    }
  } else {
    alert("クリックした位置の近くに解体できるあなたの路線が見つかりません。");
  }
}

// =========================================================
// E. UIとイベント処理
// =========================================================

function toggleConstructionMode(newMode) {
  const mapContainer = map.getContainer();

  L.DomUtil.removeClass(mapContainer, "station-mode");
  L.DomUtil.removeClass(mapContainer, "track-mode");
  L.DomUtil.removeClass(mapContainer, "dismantle-station-mode");
  L.DomUtil.removeClass(mapContainer, "dismantle-line-mode");

  map.off("click", handleStationCreation);
  map.off("click", handleLineDismantle);

  if (drawingPolyline) map.removeLayer(drawingPolyline);
  drawingPolyline = null;
  lineCandidateNodes = [];

  Game.mode = newMode;

  document
    .querySelectorAll(".rail-ui-control button")
    .forEach((btn) => btn.classList.remove("active"));

  if (newMode === "station") {
    L.DomUtil.addClass(mapContainer, "station-mode");
    document.getElementById("btn-station-mode").classList.add("active");
    map.on("click", handleStationCreation);
  } else if (newMode === "track") {
    L.DomUtil.addClass(mapContainer, "track-mode");
    document.getElementById("btn-track-mode").classList.add("active");
  } else if (newMode === "dismantle-station") {
    L.DomUtil.addClass(mapContainer, "dismantle-station-mode");
    document
      .getElementById("btn-dismantle-station-mode")
      .classList.add("active");
  } else if (newMode === "dismantle-line") {
    L.DomUtil.addClass(mapContainer, "dismantle-line-mode");
    document.getElementById("btn-dismantle-line-mode").classList.add("active");
    map.on("click", handleLineDismantle);
  } else {
    document.getElementById("btn-station-mode").classList.add("active"); // アイドル状態の強調
  }
}

function updateVehicleBuyUI() {
  const container = document.getElementById("vehicle-buy-container");
  container.innerHTML = `<h4>🚆 車両購入・路線割当</h4>`;

  if (Game.establishedLines.length === 0) {
    container.innerHTML += `<p>路線を建設すると車両が購入できます。</p>`;
    return;
  }

  if (Object.keys(VehicleData).length === 0) {
    container.innerHTML += `<p>車両データをサーバーから取得中...</p>`;
    return;
  }

  const sortedVehicleKeys = Object.keys(VehicleData).sort(
    (a, b) =>
      VehicleData[a].purchaseMultiplier - VehicleData[b].purchaseMultiplier
  );

  sortedVehicleKeys.forEach((key) => {
    const data = VehicleData[key];
    const purchaseCost = VEHICLE_BASE_COST * data.purchaseMultiplier;

    const availableLines = Game.establishedLines.filter((line) => {
      const isLinear = data.name === "リニア";

      if (isLinear) return line.trackType === "linear";
      if (line.trackType === "linear") return false;

      return true;
    });

    const lineSelect = `<select id="line-select-${key}" style="width: 50%; margin-right: 5px;">
                    ${availableLines
                      .map(
                        (line) =>
                          `<option value="${line.id}">Line ${line.id} (${line.trackType})</option>`
                      )
                      .join("")}
                </select>`;

    const disabled = availableLines.length === 0 ? "disabled" : "";

    container.innerHTML += `
                    <div style="display: flex; align-items: center; margin-bottom: 5px;">
                        <span style="width: 100px; color: ${data.color};">${
      data.name
    }</span>
                        <small style="flex-grow: 1; margin-left: 10px;">${
                          data.maxSpeedKmH
                        }km/h, ¥${purchaseCost.toLocaleString()}</small>
                        ${lineSelect}
                        <button onclick="buyVehicle('${key}')" style="width: 45%;" ${disabled}>購入</button>
                    </div>
                `;
  });
}

window.buyVehicle = (vehicleKey) => {
  if (!socket) return alert("サーバーに接続されていません。");
  const lineSelect = document.getElementById(`line-select-${vehicleKey}`);
  if (!lineSelect || lineSelect.value === "") {
    alert("割り当てる路線を選択してください。");
    return;
  }
  const lineId = lineSelect.value;

  socket.emit("buyVehicle", { lineId: lineId, vehicleKey: vehicleKey });
};

window.toggleAccordion = (contentId) => {
  const content = document.getElementById(contentId);
  const header = content.previousElementSibling;
  const icon = header.querySelector("span:last-child");

  content.classList.toggle("open");
  if (content.classList.contains("open")) {
    icon.textContent = "▼";
  } else {
    icon.textContent = "▲";
  }
};

window.handleLogin = handleLogin;
window.toggleConstructionMode = toggleConstructionMode;
window.finalizeLine = finalizeLine;
window.Game = Game;

document.addEventListener("DOMContentLoaded", () => {
  // 1. Leafletマップの初期化を最初に行う
  map = L.map("map").setView([INITIAL_LAT, INITIAL_LNG], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors (Base)",
    maxZoom: 19,
  }).addTo(map);

  L.tileLayer(
    "https://cyberjapandata.gsi.go.jp/xyz/dem5a_color/{z}/{x}/{y}.png",
    { attribution: "国土地理院", opacity: 0.5 }
  ).addTo(map);

  // 2. UIコントロールをマップに追加
  const controlDiv = document.querySelector(".rail-ui-control");
  const controlHtml = controlDiv.innerHTML;
  controlDiv.remove();

  const constructControl = L.control({ position: "topleft" });
  constructControl.onAdd = function (map) {
    const div = L.DomUtil.create("div", "rail-ui-control");
    div.innerHTML = controlHtml;
    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  constructControl.addTo(map);

  // 3. 建設モードの初期化
  toggleConstructionMode("idle");

  // 4. ログイン処理
  const savedUserId = getCookie("userId");
  if (savedUserId) {
    document.getElementById("username-input").value = savedUserId;
  }
});
