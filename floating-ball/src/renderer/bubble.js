// 桌宠对话气泡渲染逻辑（外部脚本）
const el = document.getElementById('text');
window.bubbleApi.onText((t) => {
  el.textContent = t;
  el.classList.add('show');
});
window.bubbleApi.onHide(() => {
  el.classList.remove('show');
});
