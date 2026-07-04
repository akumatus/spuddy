# Positive Potato 🥔

一只住在你桌面右下角的钩织土豆，举着小卡片给你正能量。基于 Claude Design 的「Positive Potato 桌宠原型」实现。

## 运行

```bash
cd app
npm install
npm start
```

菜单栏有一个小土豆托盘图标：Show / Hide、Quit。

## 玩法

- **戳它** — 会被压扁，偶尔冒爱心和碎碎念
- **每天第一次戳** — 抽当日卡片；点 Keep it ♥ 收进卡册
- **第 3、8、13… 天** — 金线卡片（Golden Stitch）：AI 会根据你聊过的话为你亲手织一张
- **悬停土豆** — 左侧出现聊天框和图标；跟它说说心事，它会记住（Memory 标签页可随时删除）
- **卡册（♥ 图标）** — Cards / Buddies / Memory 三个标签页；集卡解锁 5 位新伙伴（Taco、Sprinkles、Bloom、Leo、Prof），解锁后可切换值班角色
- **z z 图标** — 把它收起来打个盹，点小脑袋叫醒
- **拖拽** — 把整只土豆拖到屏幕任何地方
- 连续工作 90 分钟会提醒你伸展；23 点后会劝你睡觉

## 接入 Claude API（聊天 + 金线卡片）

任选其一，都不会进仓库：

1. 把 key 写进 `~/.config/positive-potato/config.json`：
   ```json
   { "apiKey": "sk-ant-..." }
   ```
2. 或设置环境变量 `ANTHROPIC_API_KEY`
3. 或安装 `ant` CLI 后 `ant auth login`

没有 key 时自动降级为内置台词，全部功能仍可用。

## 结构

- `electron/main.cjs` — 透明置顶窗口、托盘、Claude API 调用（key 只在主进程）、久坐检测
- `src/motions.js` — 设计稿 Turn 3 的 8 种动作规范（呼吸/戳压/跳跃/倾听/举卡/躲藏/欢呼/金织）
- `src/content.js` — 设计稿的全部文案、人设、解锁规则
- `src/cardscreen.js` — 模型手中卡片上的动态文字（CanvasTexture）+ 金织自发光脉冲 + 举卡动画
- `public/models/*.glb` — 由 `3d-models/*.usdz`（Rodin AI）经 Blender 转换压缩（100 万面 → 8 万面，78MB → ~0.5MB）
- `public/models/cards.json` — 每个角色卡片平面的标定数据，由 `scripts/detect_cards.py` 生成

## 卡片平面标定（新角色接入时）

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/detect_cards.py -- \
  public/models/<id>.glb /tmp/<id>.json /tmp/<id>
```

脚本按「高亮度 + 低饱和 + 朝前法线 + 下半身」筛选卡片面片，RANSAC 拟合平面，输出中心/法线/宽高/前移量（卡面外鼓补偿），并渲染 `-front/-side/-tex` 三张验证图（红色标定块应与贴图参照图里的白卡重合）。确认无误后把 JSON 合入 `public/models/cards.json`。
