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

- **戳它（身体）** — 随机一种反应：压扁 / 跳 / 不倒翁 / 张望 / 转圈 / 打喷嚏 / 跳跃转体…（拆件角色还会翻白眼、颠卡片、挥手），最近两个动作不会重复出现；偶尔冒爱心和碎碎念——不会弹窗
- **点它手里的白卡片** — 唯一打开卡片弹窗的方式：当天没抽过就抽当日卡片（卡片上写着 tap me :)），抽过则重看今日卡片；点 Keep it ♥ 收进卡册
- **移动鼠标** — 它会转头看你的光标（眼珠先到、头再跟上）；发呆时自己眨眼、扫视
- **第 3、8、13… 天** — 金线卡片（Golden Stitch）：AI 会根据你聊过的话为你亲手织一张
- **悬停土豆** — 左侧出现聊天框和图标；跟它说说心事，它会记住（Memory 标签页可随时删除）
- **卡册（♥ 图标）** — Cards / Buddies / Memory 三个标签页；集卡解锁 5 位新伙伴（Taco、Sprinkles、Bloom、Leo、Prof），解锁后可切换值班角色
- **z z 图标** — 把它收起来打个盹，点小脑袋叫醒
- **拖拽** — 把整只土豆拖到屏幕任何地方；横向拖会把它甩得转起来，松手后欠阻尼弹簧回正
- 连续工作 90 分钟会提醒你伸展；23 点后会劝你睡觉
- **它自己会过日子（7a 人格引擎）** — 三条需求（精力/无聊/想你）随时间涨落：无聊了自娱自乐（追尾巴、颠卡片、给自己读卡片、练挥手、哼小曲）；困了打瞌睡（点头栽倒又猛地扶正，戳一下惊醒）；想你想过头会敲玻璃搭讪——回应它（戳一下）会欢呼，被无视只蔫 3 秒且退避翻倍绝不烦人；离开 30 秒以上回来会被迎接。全程用虚线手写泡喃喃自语，开口说话才用实线泡

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

- `electron/main.cjs` — 透明置顶窗口、托盘、Claude API 调用（key 只在主进程）、久坐检测、全局光标轮询
- `src/motions.js` — 设计稿 Turn 6/7 的缓动关键帧动作系统（移植自 `claude-design/project/lib/spud-scene2.js`）：分段缓动、部件轨道（爪/眼/卡）、待机生命感、光标跟随、甩转弹簧、doze/hum 待机模式
- `src/brain.js` — 7a 人格引擎（移植自 `claude-design/project/lib/spud-brain.js`）：需求驱动的自主行为（0.2s 决策 tick），四维人格（好奇/粘人/戏精/嗜睡，默认 65/60/55/35，存在 `state.personality`）；presence 来自全局光标是否在动
- `src/content.js` — 设计稿的全部文案、人设、解锁规则
- `src/cardscreen.js` — 模型手中卡片上的动态文字（CanvasTexture）+ 金织自发光脉冲；拆件模型的卡片位移由动作系统驱动
- `src/scene.js` — three.js 场景：部件铰链（爪=肩点 · 眼=自心 · 卡=底边）、接触阴影、镜头呼吸、PBR 光照（RoomEnvironment IBL + ACES tone mapping + 暖主光/rim；legacy 烘焙材质关 tone mapping 保持原样）
- `public/models/*.glb` — 拆件角色（spud、donut）由 Rodin **PBR 导出**（`base_basic_pbr.glb`）经 `scripts/process_rodin_pbr.mjs` 处理：命名部件、albedo 深腔扩散填充（眼睛 UV 保护）、图集边缘填充、简化 + Draco，保留 baseColor/normal/metallicRoughness 三张贴图交给实时光照——PBR 导出不含烘焙光照层，遮挡黑/接触阴影/接缝压痕从根上不存在；其余角色暂为单网格扫描，由 `3d-models/*.usdz` 经 Blender 转换
- `public/models/cards.json` — 每个角色卡片平面的标定数据：拆件角色由 `process_rodin_pbr.mjs` 输出，单网格角色由 `scripts/detect_cards.py` 生成

## 卡片平面标定（新角色接入时）

```bash
/Applications/Blender.app/Contents/MacOS/Blender -b -P scripts/detect_cards.py -- \
  public/models/<id>.glb /tmp/<id>.json /tmp/<id>
```

脚本按「高亮度 + 低饱和 + 朝前法线 + 下半身」筛选卡片面片，RANSAC 拟合平面，输出中心/法线/宽高/前移量（卡面外鼓补偿），并渲染 `-front/-side/-tex` 三张验证图（红色标定块应与贴图参照图里的白卡重合）。确认无误后把 JSON 合入 `public/models/cards.json`。
