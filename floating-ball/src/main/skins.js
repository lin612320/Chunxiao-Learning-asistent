// 皮肤定义：拆分球皮肤（BALL_SKINS）和面板主题（PANEL_THEMES）
//
// BALL_SKINS：每套包含渐变 + 桌宠形象 + 拖动动画 + 对话语料
//   支持两种外观模式：
//     1) 渐变+emoji：用 ball.{from,to,shape} 渲染，pet.face 是 emoji
//     2) 图片皮肤：用 ball.image 指向本地图片，pet.face 可省略
//   添加新球皮肤：只需在 BALL_SKINS 里加一项
//
// PANEL_THEMES：仅 white / dark 两套，控制面板配色

const BALL_SKINS = {
  aurora: {
    name: '极光绿',
    ball: { from: '#43e97b', to: '#38f9d7', shape: 'circle', image: null },
    pet: {
      face: '🦊', dragAnim: 'wobble',
      dialogues: ['今天也要元气满满哦！', '选中文字按 Alt+Q，我来帮你翻译~', '点点我，打开 AI 小窗', '累了吗？休息一下吧 🌿']
    }
  },
  midnight: {
    name: '暗夜紫',
    ball: { from: '#5b247a', to: '#1bcedf', shape: 'circle', image: null },
    pet: {
      face: '🦉', dragAnim: 'spin',
      dialogues: ['夜深了，知识也在发光✨', '把困惑交给我，关联查找启动中', '智慧如星辰，慢慢来', '我可以帮你梳理这段文字']
    }
  },
  sakura: {
    name: '樱花粉',
    ball: { from: '#ff9a9e', to: '#fad0c4', shape: 'blob', image: null },
    pet: {
      face: '🐱', dragAnim: 'bounce',
      dialogues: ['喵~ 有什么可以帮你吗？', '选中文字就能翻译啦！', '今日份的可爱已送达 🌸', '拖我到处跑也很好玩呢']
    }
  },
  ocean: {
    name: '深海蓝',
    ball: { from: '#2193b0', to: '#6dd5ed', shape: 'blob', image: null },
    pet: {
      face: '🐳', dragAnim: 'wobble',
      dialogues: ['深海里藏着很多答案~', '把文字丢给我，慢慢解读', '浪花朵朵，思路清晰', '别急，我们一起想想']
    }
  },
  sunset: {
    name: '日落橙',
    ball: { from: '#ff512f', to: '#f09819', shape: 'circle', image: null },
    pet: {
      face: '🐹', dragAnim: 'bounce',
      dialogues: ['囤了一口袋小知识！', '快选中文字让我瞧瞧~', '夕阳好暖，加油呀', '我可以翻译、关联、问答三合一']
    }
  },
  mono: {
    name: '石墨灰',
    ball: { from: '#3a3a3a', to: '#9b9b9b', shape: 'square', image: null },
    pet: {
      face: '🤖', dragAnim: 'shake',
      dialogues: ['系统就绪，等待指令。', 'AI 已连接，请输入问题。', '正在为你计算最佳答案…', '简洁高效，是我的风格。']
    }
  },
  // 图片皮肤示例（把图片放到 assets/ball/ 下，然后填路径）
  // custom_cat: {
  //   name: '猫咪',
  //   ball: { from: '#fff', to: '#fff', shape: 'circle', image: 'assets/ball/cat.png' },
  //   pet: { dragAnim: 'bounce', dialogues: ['喵~'] }
  // }
};

const PANEL_THEMES = {
  dark: {
    name: '深色',
    bg: 'linear-gradient(160deg,#161b22,#0d1117)',
    surface: 'rgba(255,255,255,0.05)',
    border: 'rgba(255,255,255,0.12)',
    text: '#e6edf3',
    muted: '#8b949e',
    accent: '#58a6ff',
    inputBg: 'rgba(255,255,255,0.04)',
    codeBg: 'rgba(0,0,0,0.35)',
    codeText: '#e6edf3'
  },
  light: {
    name: '白色',
    bg: 'linear-gradient(160deg,#ffffff,#f0f2f5)',
    surface: 'rgba(0,0,0,0.035)',
    border: 'rgba(0,0,0,0.12)',
    text: '#1a1a1a',
    muted: '#6b7280',
    accent: '#2563eb',
    inputBg: 'rgba(0,0,0,0.025)',
    codeBg: 'rgba(0,0,0,0.06)',
    codeText: '#1a1a1a'
  }
};

const SHAPES = {
  circle: '50%',
  blob: '42% 58% 55% 45% / 55% 45% 55% 45%',
  square: '16px',
  capsule: '40% / 45%'
};

function getBallSkin(id) { return BALL_SKINS[id] || BALL_SKINS.aurora; }
function listBallSkins() {
  return Object.entries(BALL_SKINS).map(([id, s]) => ({
    id, name: s.name, face: s.pet?.face, image: s.ball?.image,
    from: s.ball.from, to: s.ball.to
  }));
}
function getPanelTheme(id) { return PANEL_THEMES[id] || PANEL_THEMES.dark; }
function listPanelThemes() {
  return Object.entries(PANEL_THEMES).map(([id, t]) => ({ id, name: t.name }));
}

// 兼容旧调用：getSkin 返回球皮肤 + 主题（向后兼容）
function getSkin(id) { return getBallSkin(id); }

module.exports = {
  BALL_SKINS, PANEL_THEMES, SHAPES,
  getBallSkin, listBallSkins,
  getPanelTheme, listPanelThemes,
  getSkin // 向后兼容
};
