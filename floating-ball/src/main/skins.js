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
  whale: {
    // R11：**鲸鱼娘** —— 用「云鲸女仆」形象（云鲸纸面皮肤的 PET_ART），站在品牌蓝球面上。
    //   形象图随包分发在 `assets/mascot-maid.webp`；`pet.art` 让 ball.js 用 <img> 显示它
    //   （球面渐变仍在，所以透明底的形象有底色可衬）。
    name: '鲸鱼娘',
    ball: { from: '#7fb9d0', to: '#5aa7d8', shape: 'circle', image: null },
    pet: {
      art: 'assets/mascot-maid.webp', dragAnim: 'wobble',
      dialogues: ['选中文字按 Alt+Q，我来帮你查材料~', '点点我，打开 AI 小窗', '这段我先去你的材料里找一找', '累了吗？休息一下吧 🐳']
    }
  },
  aurora: {
    name: '极光绿',
    ball: { from: '#43e97b', to: '#38f9d7', shape: 'circle', image: null },
    pet: {
      face: '🦊', dragAnim: 'wobble',
      dialogues: ['今天也要元气满满哦！', '选中文字按 Alt+Q，我来帮你查材料~', '点点我，打开 AI 小窗', '累了吗？休息一下吧 🌿']
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
      dialogues: ['喵~ 有什么可以帮你吗？', '选中文字就能问春晓啦！', '今日份的可爱已送达 🌸', '拖我到处跑也很好玩呢']
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
      dialogues: ['囤了一口袋小知识！', '快选中文字让我瞧瞧~', '夕阳好暖，加油呀', '我可以关联材料、问答两用']
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
    // R11：换成「云鲸纸面」深色令牌（暮蓝纸面 + 月色蓝强调 + 图上雾色 haze）
    name: '深色',
    bg: '#172435',
    haze: 'rgba(18,31,47,.52)',
    drawerBg: '#1c2d42',
    surface: 'rgba(28,45,66,.96)',
    border: 'rgba(167,199,216,.18)',
    text: '#e4edf2',
    muted: '#b9c8d2',
    accent: '#83bcdc',
    inputBg: 'rgba(23,36,53,.92)',
    codeBg: 'rgba(28,45,66,.98)',
    codeText: '#e4edf2'
  },
  light: {
    // R11：云鲸纸面浅色令牌（纸白 + 淡天蓝）
    name: '白色',
    bg: '#eef6f8',
    haze: 'rgba(255,254,249,.60)',
    drawerBg: '#f7f9f6',
    surface: 'rgba(247,249,246,.94)',
    border: 'rgba(72,112,132,.22)',
    text: '#243746',
    muted: '#486170',
    accent: '#5aa7d8',
    inputBg: 'rgba(255,255,252,.96)',
    codeBg: 'rgba(239,246,247,.98)',
    codeText: '#243746'
  }
};

const SHAPES = {
  circle: '50%',
  blob: '42% 58% 55% 45% / 55% 45% 55% 45%',
  square: '16px',
  capsule: '40% / 45%'
};

function getBallSkin(id) { return BALL_SKINS[id] || BALL_SKINS.whale; }
function listBallSkins() {
  return Object.entries(BALL_SKINS).map(([id, s]) => ({
    id, name: s.name, face: s.pet?.face, image: s.ball?.image,
    // R10/R11：`whale` = 用鲸鱼标识当形象；`art` = 用一张形象图（云鲸女仆）当形象。
    //   换肤窗据此画预览，而不是显示一个空的 face。
    whale: !!(s.pet && s.pet.whale),
    art: (s.pet && s.pet.art) || null,
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
