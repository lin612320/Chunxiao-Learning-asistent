// 悬浮球渲染逻辑（外部脚本，规避 CSP 对内联脚本的限制）
const ball = document.getElementById('ball');
const faceEl = document.getElementById('face');

const SHAPES = {
  circle: '50%',
  blob: '42% 58% 55% 45% / 55% 45% 55% 45%',
  square: '16px',
  capsule: '40% / 45%'
};

// 应用完整皮肤对象（含 pet），支持渐变和图片两种外观
function applySkin(skin) {
  if (!skin) return;
  const r = document.documentElement.style;
  r.setProperty('--radius', SHAPES[skin.ball?.shape] || '50%');
  r.setProperty('--anim', skin.pet?.dragAnim || 'wobble');
  if (skin.ball?.image) {
    // 图片皮肤：隐藏渐变，显示图片
    ball.style.background = `url(${skin.ball.image}) center/cover no-repeat`;
    faceEl.style.display = 'none';
  } else {
    // 渐变皮肤
    ball.style.background = '';
    r.setProperty('--from', skin.ball?.from || '#43e97b');
    r.setProperty('--to', skin.ball?.to || '#38f9d7');
    faceEl.style.display = skin.pet?.face ? 'flex' : 'none';
    if (skin.pet?.face) faceEl.textContent = skin.pet.face;
  }
}

if (window.ballApi) {
  window.ballApi.onSkin(applySkin);
}

// ---- 悬停对话气泡 ----
ball.addEventListener('mouseenter', () => {
  if (window.ballApi) window.ballApi.hover();
});
ball.addEventListener('mouseleave', () => {
  if (window.ballApi) window.ballApi.leave();
});

// ---- 拖动 + 点击区分 ----
// 拖动移动由主进程轮询光标完成，此处只负责动画与点击判定
let down = null;
let dragging = false;

ball.addEventListener('mousedown', (e) => {
  // 只处理左键，右键/中键直接跳过（避免右键菜单触发面板）
  if (e.button !== 0) return;
  down = { x: e.screenX, y: e.screenY, t: Date.now() };
  dragging = false;
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!down) return;
  if (Math.abs(e.screenX - down.x) > 3 || Math.abs(e.screenY - down.y) > 3) {
    if (!dragging) {
      dragging = true;
      ball.classList.add('dragging');
      if (window.ballApi) window.ballApi.startDrag();
    }
  }
});

window.addEventListener('mouseup', (e) => {
  // 只处理左键抬起
  if (!down || e.button !== 0) return;
  const dt = Date.now() - down.t;
  if (dragging) {
    ball.classList.remove('dragging', 'drop-hover');
    if (window.ballApi) window.ballApi.stopDrag();
  } else if (dt < 400) {
    // 未拖动视为点击
    if (window.ballApi) window.ballApi.click();
  }
  down = null;
  dragging = false;
});

// 兜底清理：窗口失焦 / 拖拽中断时，确保不留 `dragging`/`drop-hover` 卡死态
// （旧版若状态残留，球体会一直停留在放大/图标替换观感，重复拖拽后愈发明显）
function clearBallState() {
  if (!dragging && !down) return;
  down = null;
  dragging = false;
  ball.classList.remove('dragging', 'drop-hover');
  if (window.ballApi && typeof window.ballApi.stopDrag === 'function') window.ballApi.stopDrag();
}
window.addEventListener('blur', clearBallState);
window.addEventListener('dragend', clearBallState);

// ---- 文本拖入（手动抓取模式：把选中文字拖到球上）----
ball.addEventListener('dragenter', (e) => {
  e.preventDefault();
  ball.classList.add('drop-hover');
});
ball.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
ball.addEventListener('dragleave', () => ball.classList.remove('drop-hover'));
ball.addEventListener('drop', (e) => {
  e.preventDefault();
  ball.classList.remove('drop-hover');
  const text = (e.dataTransfer && (e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text'))) || '';
  if (text.trim() && window.ballApi) window.ballApi.dropText(text.trim());
});

// 默认外观，收到主进程皮肤前先有一帧可用
applySkin({
  ball: { from: '#43e97b', to: '#38f9d7' },
  pet: { shape: 'circle', face: '🦊', dragAnim: 'wobble' }
});
