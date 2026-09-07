"use strict";

// ------------------------------------------------------------------
// キャンバス・砂時計の形状パラメータ
// ------------------------------------------------------------------
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const W = canvas.width;
const H = canvas.height;

const MARGIN = 60;
const OUTER_LEFT = MARGIN;
const OUTER_RIGHT = W - MARGIN;
const TOP_Y = 50;
const BOTTOM_Y = H - 50;
const CENTER_X = W / 2;
const NECK_HALF_WIDTH = 14;
const NECK_HEIGHT = 26;
const MID_Y = (TOP_Y + BOTTOM_Y) / 2;
const NECK_TOP_Y = MID_Y - NECK_HEIGHT / 2;
const NECK_BOTTOM_Y = MID_Y + NECK_HEIGHT / 2;

// 輪郭描画用の頂点（上ガラス球 -> ネック -> 下ガラス球）
const OUTLINE_POINTS = [
  { x: OUTER_LEFT, y: TOP_Y },
  { x: OUTER_RIGHT, y: TOP_Y },
  { x: CENTER_X + NECK_HALF_WIDTH, y: NECK_TOP_Y },
  { x: CENTER_X + NECK_HALF_WIDTH, y: NECK_BOTTOM_Y },
  { x: OUTER_RIGHT, y: BOTTOM_Y },
  { x: OUTER_LEFT, y: BOTTOM_Y },
  { x: CENTER_X - NECK_HALF_WIDTH, y: NECK_BOTTOM_Y },
  { x: CENTER_X - NECK_HALF_WIDTH, y: NECK_TOP_Y },
];

// y座標を与えると、その高さでの砂時計内壁の左端/右端のx座標を返す。
// 上下の球はテーパー状の台形、ネック部分は一定幅の通路として扱う。
function leftBoundAt(y) {
  if (y <= NECK_TOP_Y) {
    const t = (y - TOP_Y) / (NECK_TOP_Y - TOP_Y);
    return OUTER_LEFT + t * (CENTER_X - NECK_HALF_WIDTH - OUTER_LEFT);
  } else if (y >= NECK_BOTTOM_Y) {
    const t = (y - NECK_BOTTOM_Y) / (BOTTOM_Y - NECK_BOTTOM_Y);
    return (CENTER_X - NECK_HALF_WIDTH) + t * (OUTER_LEFT - (CENTER_X - NECK_HALF_WIDTH));
  }
  return CENTER_X - NECK_HALF_WIDTH;
}

function rightBoundAt(y) {
  if (y <= NECK_TOP_Y) {
    const t = (y - TOP_Y) / (NECK_TOP_Y - TOP_Y);
    return OUTER_RIGHT + t * (CENTER_X + NECK_HALF_WIDTH - OUTER_RIGHT);
  } else if (y >= NECK_BOTTOM_Y) {
    const t = (y - NECK_BOTTOM_Y) / (BOTTOM_Y - NECK_BOTTOM_Y);
    return (CENTER_X + NECK_HALF_WIDTH) + t * (OUTER_RIGHT - (CENTER_X + NECK_HALF_WIDTH));
  }
  return CENTER_X + NECK_HALF_WIDTH;
}

// ------------------------------------------------------------------
// 物理パラメータ
// ------------------------------------------------------------------
const GRAVITY = 950; // px/s^2
const SUBSTEPS = 4;
const COLLISION_ITERATIONS = 2;
const VELOCITY_DAMPING = 0.995;
const RESTITUTION_PARTICLE = 0.15;
const FRICTION_PARTICLE = 0.5;
const RESTITUTION_WALL = 0.25;
// 壁に接触し続けた場合、1秒あたりに残る壁沿い方向速度の割合（0.5なら1秒でおよそ半分に減衰）
const WALL_FRICTION_PER_SECOND = 0.5;

// 粒子同士の相対速度がこれより小さい衝突は反発させず、運動量を吸収する（静止摩擦的な挙動）
const REST_VELOCITY_THRESHOLD = 60; // px/s
// これ未満のめり込みは位置補正しない（補正→再めり込みを繰り返す微振動ループを防ぐ）
const POSITION_SLOP = 0.01; // px
// 一度に補正する割合を抑え、深い山の中で補正が過剰になって粒子が弾き飛ばされるのを防ぐ
const POSITION_CORRECTION_PERCENT = 0.4;

// 一定時間ほぼ静止した粒子は「休止」させ、重力・自発的な移動を止める。
// 積み重なった粒子の接触解決は反復回数が少ないと下からの支持力が上まで伝わりきらず、
// 山全体がいつまでも小さく弾み続けてしまうため、静止した粒子を能動的に止めることで解決する。
// ただし休止中も周囲の粒子からの衝突（位置補正・速度伝達）は通常どおり受けるため、
// 強い衝撃（反転操作など）を受ければ自然に目を覚まして動き出す。
const SLEEP_SPEED_THRESHOLD = 20; // px/s
const SLEEP_TIME_REQUIRED = 0.3; // 秒
// 休止中の粒子は、これを超える速さで近づいてくる衝突を受けたときだけ目を覚ます
const WAKE_VELOCITY_THRESHOLD = 80; // px/s

const REF_PARTICLE_COUNT = 2000;
const BASE_RADIUS = 3.2;
const MIN_RADIUS = 1.3;
const MAX_RADIUS = 4.5;

const SAND_COLORS = ["#e0b872", "#d9a85c", "#c99a52", "#e8c68a", "#cf9f4f"];

let PARTICLE_RADIUS = BASE_RADIUS;
let particles = [];
let cellSize = PARTICLE_RADIUS * 2.2;
let gridCols = 1;
let gridRows = 1;
let grid = [];

class Particle {
  constructor(x, y, r) {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.r = r;
    this.color = SAND_COLORS[(Math.random() * SAND_COLORS.length) | 0];
    this.resting = false;
    this.restTimer = 0;
  }
}

// 粒子半径は要求粒子数に応じて動的に決める。
// 粒子数が増えるほど半径を小さくし、上球に収まりやすくする。
function computeRadius(count) {
  const r = BASE_RADIUS * Math.sqrt(REF_PARTICLE_COUNT / count);
  return Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, r));
}

// 上球内に、行ごとに粒子を敷き詰める形で初期配置する。
function initParticles(requestedCount) {
  PARTICLE_RADIUS = computeRadius(requestedCount);
  cellSize = PARTICLE_RADIUS * 2.2;
  gridCols = Math.max(1, Math.ceil(W / cellSize));
  gridRows = Math.max(1, Math.ceil(H / cellSize));

  particles = [];
  const r = PARTICLE_RADIUS;
  const spacingY = r * 2.05;
  let y = TOP_Y + r * 1.5;

  // 上球に収まりきらない場合は、ネック・下球側にも続けて敷き詰める
  while (particles.length < requestedCount && y < BOTTOM_Y - r) {
    const leftX = leftBoundAt(y) + r;
    const rightX = rightBoundAt(y) - r;
    const rowWidth = rightX - leftX;
    if (rowWidth > 0) {
      const spacingX = r * 2.05;
      const cols = Math.max(1, Math.floor(rowWidth / spacingX) + 1);
      for (let c = 0; c < cols && particles.length < requestedCount; c++) {
        const x = cols === 1 ? (leftX + rightX) / 2 : leftX + (c * rowWidth) / (cols - 1);
        particles.push(
          new Particle(
            x + (Math.random() - 0.5) * 0.5,
            y + (Math.random() - 0.5) * 0.5,
            r
          )
        );
      }
    }
    y += spacingY;
  }

  document.getElementById("particleActual").textContent =
    `配置粒子数: ${particles.length} / 要求: ${requestedCount}`;
}

// ------------------------------------------------------------------
// 壁との衝突（高さごとの左右境界にクランプする方式）
// ------------------------------------------------------------------
// frictionFactor を渡したときだけ、壁沿い方向の速度に摩擦を適用する。
// （1フレーム中に何度も呼ばれるため、摩擦は呼び出し側で1サブステップにつき1回だけ有効にする）
function containParticle(p, frictionFactor) {
  const r = p.r;

  if (p.y < TOP_Y + r) {
    p.y = TOP_Y + r;
    if (p.vy < 0) {
      p.vy = -p.vy < REST_VELOCITY_THRESHOLD ? 0 : p.vy * -RESTITUTION_WALL;
    }
    if (frictionFactor !== undefined) p.vx *= frictionFactor;
  } else if (p.y > BOTTOM_Y - r) {
    p.y = BOTTOM_Y - r;
    if (p.vy > 0) {
      p.vy = p.vy < REST_VELOCITY_THRESHOLD ? 0 : p.vy * -RESTITUTION_WALL;
    }
    if (frictionFactor !== undefined) p.vx *= frictionFactor;
  }

  const lb = leftBoundAt(p.y) + r;
  const rb = rightBoundAt(p.y) - r;

  if (p.x < lb) {
    p.x = lb;
    if (p.vx < 0) {
      p.vx = -p.vx < REST_VELOCITY_THRESHOLD ? 0 : p.vx * -RESTITUTION_WALL;
    }
    p.vx += (Math.random() - 0.5) * 0.05;
    if (frictionFactor !== undefined) p.vy *= frictionFactor;
  } else if (p.x > rb) {
    p.x = rb;
    if (p.vx > 0) {
      p.vx = p.vx < REST_VELOCITY_THRESHOLD ? 0 : p.vx * -RESTITUTION_WALL;
    }
    p.vx += (Math.random() - 0.5) * 0.05;
    if (frictionFactor !== undefined) p.vy *= frictionFactor;
  }
}

// ------------------------------------------------------------------
// 粒子同士の衝突（空間分割グリッドで近傍のみ判定）
// ------------------------------------------------------------------
function buildGrid() {
  const size = gridCols * gridRows;
  if (grid.length !== size) {
    grid = new Array(size);
    for (let i = 0; i < size; i++) grid[i] = [];
  } else {
    for (let i = 0; i < size; i++) grid[i].length = 0;
  }

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    const cx = Math.min(gridCols - 1, Math.max(0, (p.x / cellSize) | 0));
    const cy = Math.min(gridRows - 1, Math.max(0, (p.y / cellSize) | 0));
    grid[cy * gridCols + cx].push(i);
  }
}

function resolvePair(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let dist = Math.hypot(dx, dy);
  const minDist = a.r + b.r;
  if (dist >= minDist) return;
  if (dist < 1e-6) dist = 1e-6;

  const nx = dx / dist;
  const ny = dy / dist;
  const overlap = minDist - dist;

  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const velAlongNormal = rvx * nx + rvy * ny;
  const approachSpeed = -velAlongNormal; // 正なら近づいている

  // 休止中の粒子は、強い衝撃を受けたときだけ目を覚まして通常どおり動けるようにする。
  // （弱い接触のたびに毎回動かしてしまうと、いつまでも休止条件を満たせず山全体が
  //   静止できなくなるため）
  if (a.resting && approachSpeed > WAKE_VELOCITY_THRESHOLD) {
    a.resting = false;
    a.restTimer = 0;
  }
  if (b.resting && approachSpeed > WAKE_VELOCITY_THRESHOLD) {
    b.resting = false;
    b.restTimer = 0;
  }

  const aFixed = a.resting;
  const bFixed = b.resting;
  if (aFixed && bFixed) return; // 両方休止中なら何もしない（既に安定している）

  // 微小なめり込みは補正しない（補正→再めり込みを繰り返す振動を防ぐ）
  const correction = Math.max(overlap - POSITION_SLOP, 0) * POSITION_CORRECTION_PERCENT;
  if (correction > 0) {
    if (aFixed) {
      b.x += nx * correction;
      b.y += ny * correction;
    } else if (bFixed) {
      a.x -= nx * correction;
      a.y -= ny * correction;
    } else {
      a.x -= nx * correction * 0.5;
      a.y -= ny * correction * 0.5;
      b.x += nx * correction * 0.5;
      b.y += ny * correction * 0.5;
    }
  }

  if (velAlongNormal < 0) {
    // ゆっくりとした接触（静止に近い状態）は反発させず、運動量を吸収して止める。
    // これにより積み重なった粒子がいつまでも弾み続けるのを防ぐ。
    const restitution = approachSpeed < REST_VELOCITY_THRESHOLD ? 0 : RESTITUTION_PARTICLE;
    const totalImpulse = -(1 + restitution) * velAlongNormal;
    if (aFixed) {
      b.vx += totalImpulse * nx;
      b.vy += totalImpulse * ny;
    } else if (bFixed) {
      a.vx -= totalImpulse * nx;
      a.vy -= totalImpulse * ny;
    } else {
      const jImpulse = totalImpulse / 2;
      a.vx -= jImpulse * nx;
      a.vy -= jImpulse * ny;
      b.vx += jImpulse * nx;
      b.vy += jImpulse * ny;
    }
  }

  const tx = -ny;
  const ty = nx;
  const rvt = (b.vx - a.vx) * tx + (b.vy - a.vy) * ty;
  if (aFixed) {
    b.vx -= tx * rvt * FRICTION_PARTICLE;
    b.vy -= ty * rvt * FRICTION_PARTICLE;
  } else if (bFixed) {
    a.vx += tx * rvt * FRICTION_PARTICLE;
    a.vy += ty * rvt * FRICTION_PARTICLE;
  } else {
    const frictionImpulse = rvt * FRICTION_PARTICLE * 0.5;
    a.vx += tx * frictionImpulse;
    a.vy += ty * frictionImpulse;
    b.vx -= tx * frictionImpulse;
    b.vy -= ty * frictionImpulse;
  }
}

function resolveParticleCollisions() {
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    const cx = Math.min(gridCols - 1, Math.max(0, (p.x / cellSize) | 0));
    const cy = Math.min(gridRows - 1, Math.max(0, (p.y / cellSize) | 0));

    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      if (gy < 0 || gy >= gridRows) continue;
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        if (gx < 0 || gx >= gridCols) continue;
        const cell = grid[gy * gridCols + gx];
        for (let k = 0; k < cell.length; k++) {
          const j = cell[k];
          if (j <= i) continue;
          resolvePair(p, particles[j]);
        }
      }
    }
  }
}

// ------------------------------------------------------------------
// シミュレーションステップ
// ------------------------------------------------------------------
function step(dt) {
  const subDt = dt / SUBSTEPS;
  const wallFrictionFactor = Math.pow(WALL_FRICTION_PER_SECOND, subDt);

  for (let s = 0; s < SUBSTEPS; s++) {
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p.resting) {
        p.vy += GRAVITY * subDt;
        p.vx *= VELOCITY_DAMPING;
        p.vy *= VELOCITY_DAMPING;
        p.x += p.vx * subDt;
        p.y += p.vy * subDt;
      }
      containParticle(p); // 位置補正のみ（摩擦はここでは適用しない）
    }

    buildGrid();
    for (let iter = 0; iter < COLLISION_ITERATIONS; iter++) {
      resolveParticleCollisions();
    }
    for (let i = 0; i < particles.length; i++) {
      // このサブステップで壁に接触している場合、ここで1回だけ摩擦を適用
      containParticle(particles[i], wallFrictionFactor);
    }
  }

  // 一定時間ほぼ静止していた粒子を休止させる（衝突による目覚めは resolvePair 側で自然に発生する）
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    const speed2 = p.vx * p.vx + p.vy * p.vy;
    if (speed2 < SLEEP_SPEED_THRESHOLD * SLEEP_SPEED_THRESHOLD) {
      p.restTimer += dt;
      if (p.restTimer > SLEEP_TIME_REQUIRED) {
        p.resting = true;
        p.vx = 0;
        p.vy = 0;
      }
    } else {
      p.restTimer = 0;
      p.resting = false;
    }
  }
}

// ------------------------------------------------------------------
// 描画
// ------------------------------------------------------------------
function draw() {
  ctx.clearRect(0, 0, W, H);

  // ガラスの輪郭
  ctx.beginPath();
  ctx.moveTo(OUTLINE_POINTS[0].x, OUTLINE_POINTS[0].y);
  for (let i = 1; i < OUTLINE_POINTS.length; i++) {
    ctx.lineTo(OUTLINE_POINTS[i].x, OUTLINE_POINTS[i].y);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(138, 180, 214, 0.05)";
  ctx.fill();
  ctx.strokeStyle = "#8ab4d6";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // 木製スタンド風の上下バー
  ctx.fillStyle = "#6b4a30";
  ctx.fillRect(OUTER_LEFT - 20, TOP_Y - 14, (OUTER_RIGHT - OUTER_LEFT) + 40, 10);
  ctx.fillRect(OUTER_LEFT - 20, BOTTOM_Y + 4, (OUTER_RIGHT - OUTER_LEFT) + 40, 10);

  // 砂粒子
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
  }
}

// ------------------------------------------------------------------
// メインループ / FPS計測
// ------------------------------------------------------------------
let lastTime = performance.now();
let fpsSmoothed = 60;
const fpsEl = document.getElementById("fps");

function loop(now) {
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  dt = Math.min(dt, 1 / 30); // タブ切り替え等での大ジャンプを防ぐ

  step(dt);
  draw();

  const instFps = dt > 0 ? 1 / dt : 60;
  fpsSmoothed += (instFps - fpsSmoothed) * 0.1;
  fpsEl.textContent = `FPS: ${fpsSmoothed.toFixed(0)}`;

  requestAnimationFrame(loop);
}

// ------------------------------------------------------------------
// UI
// ------------------------------------------------------------------
const particleCountInput = document.getElementById("particleCount");
const particleCountValue = document.getElementById("particleCountValue");
const resetBtn = document.getElementById("resetBtn");
const flipBtn = document.getElementById("flipBtn");

particleCountInput.addEventListener("input", () => {
  particleCountValue.textContent = particleCountInput.value;
});

resetBtn.addEventListener("click", () => {
  initParticles(parseInt(particleCountInput.value, 10));
});

flipBtn.addEventListener("click", () => {
  // 砂時計を180度回転させる = 各粒子を中心点about点対称に反転
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    p.x = W - p.x;
    p.y = H - p.y;
    p.vx = -p.vx;
    p.vy = -p.vy;
    p.resting = false; // 休止中の粒子も反転後は落下を再開させる
    p.restTimer = 0;
  }
});

// ------------------------------------------------------------------
// 起動
// ------------------------------------------------------------------
initParticles(parseInt(particleCountInput.value, 10));
requestAnimationFrame(loop);
