const $ = (id) => document.getElementById(id);
let currentSkin = 'whale';

function applySkinId(id) {
  currentSkin = id;
  document.querySelectorAll('.skin-card').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === id);
  });
}

function render(list, selectedId) {
  const grid = $('skinGrid');
  grid.innerHTML = '';
  for (const s of list) {
    const card = document.createElement('div');
    card.className = 'skin-card';
    card.dataset.id = s.id;

    const ball = document.createElement('div');
    ball.className = 'ball-preview';
    if (s.image) {
      ball.style.backgroundImage = `url(${s.image})`;
    } else {
      ball.style.background = `linear-gradient(135deg, ${s.from}, ${s.to})`;
    }
    if (s.art) {
      // R11：图片形象（云鲸女仆）—— 预览直接放这张图
      const img = document.createElement('img');
      img.className = 'whale-preview';
      img.src = s.art;
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      ball.appendChild(img);
    } else if (s.whale && window.CX_WHALE && window.CX_WHALE.path) {
      // R10：鲸鱼娘 —— 预览也画真鲸鱼（不然这张卡片只有一个空的蓝球）
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', window.CX_WHALE.viewBox);
      svg.setAttribute('class', 'whale-preview');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', window.CX_WHALE.path);
      path.setAttribute('fill', '#fff');
      svg.appendChild(path);
      ball.appendChild(svg);
    } else {
      ball.textContent = s.face || '';
    }
    card.appendChild(ball);

    const name = document.createElement('div');
    name.className = 'skin-name';
    name.textContent = s.name;
    card.appendChild(name);

    card.addEventListener('click', () => {
      applySkinId(s.id);
      window.api.setSkin(s.id);
    });
    grid.appendChild(card);
  }
  applySkinId(selectedId);
}

// 拖动
const topBar = $('top'); let drag = null;
topBar.addEventListener('mousedown', (e) => {
  if (e.target.tagName === 'BUTTON') return;
  drag = { sx: e.screenX, sy: e.screenY, moved: false }; topBar.classList.add('dragging');
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.movementX || 0, dy = e.movementY || 0;
  if (Math.abs(e.screenX - drag.sx) > 3 || Math.abs(e.screenY - drag.sy) > 3) drag.moved = true;
  if (drag.moved && window.api.move) window.api.move(dx, dy);
});
window.addEventListener('mouseup', () => { if (drag) { topBar.classList.remove('dragging'); drag = null; } });

$('btnClose').addEventListener('click', () => window.api.close());

window.api.onApplySkin((id) => applySkinId(id));

(async function init() {
  const { skins, config } = await window.api.getState();
  render(skins, config.skin);
})();
