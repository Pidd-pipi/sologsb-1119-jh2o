# sologsb-1119 化石修复工序档案（gbfossilprep）

面向博物馆化石修复技师的工序留痕工作台：标本从入库、清修、加固到交付逐节点留痕，登记工具与胶种用量，并做修复前后对照。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21819**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | MUI（Material UI）v5 |
| 构建 | Vite 5 |
| 状态管理 | Zustand |
| 路由 | React Router v6（BrowserRouter） |
| 本地存储 | IndexedDB（Dexie 4），影像单独建表，含结构版本号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1119/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.tsx
        ├── router/index.tsx
        ├── types/{specimen,procedure,supply,schedule,photo}.ts
        ├── stores/{specimen,procedure,supply,schedule}Store.ts
        ├── components/common/{ProcedureTimeline,BeforeAfterSlider,SpecimenCard,MeasureField}.tsx
        ├── hooks/{useSpecimenSearch,usePrepProgress,useStockSync}.ts
        ├── pages/{SpecimenList,SpecimenDetail,ProcedureForm,ScheduleWorkbench,ScheduleDetail,SupplyList,CompareView}.tsx
        └── utils/{db,allocation,stockSync,unitConvert,id}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/specimens` | 标本台账：按号/分类/产地/状态筛选，状态分栏 | Specimen |
| `/specimens/:id` | 标本详情 + 工序时间线 + 影像留痕 | Specimen、PrepProcedure、PrepPhoto |
| `/procedures/new` | 新建工序节点：按类型动态出工具/磨料/胶种字段与默认耗材，序号跳号报错 | PrepProcedure、Specimen |
| `/schedules` | 修复批次排程工作台：勾选多标本/工序、FEFO 分配、缺口、草稿/确认/领用/取消 | PrepSchedule、PrepProcedure、SupplyLot |
| `/schedules/:id` | 排程详情：计划工序、批次占用与预占/领用/退回轨迹、操作者 | PrepSchedule、SupplyLot |
| `/supplies` | 工具材料台账：按种类分组、批号追溯、在库/预占/可用、流水、领用登记 | SupplyLot |
| `/compare/:specimenId` | 前后对照滑块联看 + 导出对照说明文本 | PrepPhoto、PrepProcedure |

`/` 重定向到 `/specimens`，未匹配路由同样兜底到 `/specimens`。

## 数据存储说明

- 数据库名 `gbfossilprep`，当前结构版本 **v3**（`localStorage['gbfossilprep:db-version']` 记录）。
- 五张表：`specimens`（标本）、`procedures`（修复工序）、`supplies`（工具材料批次 + 库存流水）、`schedules`（修复批次排程）、`photos`（修复影像 dataUrl 独立表）。
- v1 → v2 迁移：为老数据补齐 `state`、`tools`、`photoBeforeIds/AfterIds`、`issues`、`lowThreshold` 字段并新增索引。
- v2 → v3 迁移：
  - 新增 `schedules` 排程表（草稿 / 已确认 / 已领用 / 已取消）。
  - 材料批次新增 `reservedQty`（已预占量）与 `movements`（预占 / 解除预占 / 领用 / 退回流水）；旧 `issues` 手填领用记录迁移成 `issue` 流水并保留原字段。
  - 旧工序补出可追溯的 `materials` 默认耗材明细（标注来源「默认用量」），**旧已完成工序状态与完成时间保持不变**。
- 容器无状态、不挂载命名卷；换浏览器或清空站点数据即回到初始示范数据。
- 首次打开会灌入 2 件示范标本、2 个工序节点、含「临期 / 正常 / 已过期」三批次的胶种等材料、1 张示范排程草稿与 2 张留痕影像。

## 修复批次排程工作台（v3 新增）

入口：顶部「排程工作台」或路由 `/schedules`；排程详情 `/schedules/:id`。

- **勾选排程**：勾选多件标本自动带出其待办 / 已回退计划工序（含可追溯默认耗材明细，可调整用量或增补耗材/工序）。
- **确认排程占用材料**：右侧实时按 **FEFO 临期优先**（到期越早越先用）分配到批次，**自动跳过已过期批次**并明示。
- **材料不足整份不动**：任一种材料不足时事务整体回滚，排程与库存保持原样，并列出每种材料的缺口数量与来源工序。
- **草稿零库存影响**：保存草稿只写排程表，不触碰任何库存数量。
- **取消按原批次退回**：已确认未领用的部分仅解除预占（实物未离库）；已领用的部分按确认时写定的原批次实物退回。
- **操作幂等**：重复确认 / 重复领用 / 重复取消只产生一次库存变化（状态守卫 + 单条预占流水 `refId` 串联领用与退回）。
- **库存口径**：在库（实物）、已预占、可用 = 在库 − 已预占；手填领用只能使用可用量，不能占用其它排程的预占。
- **可追溯**：材料台账与排程详情都展示预占 / 领用 / 退回的数量、批号、时间与操作者。
- **跨窗口同步**：另一窗口改动库存后，当前窗口顶部提示「库存已变」，并自动从 IndexedDB 刷新、保留最新数量（BroadcastChannel，storage 事件兜底）。

## 功能要点

- **工序序号不跳号**：新建节点时若序号大于「当前最大序号 + 1」直接报错并给出建议序号。
- **工序回退**：已完成节点可回退，回退后计入待办与回退计数。
- **低量高亮**：在库 ≤ 低量阈值的批次整行高亮并标注「低量」，剩余保质期为负时红色标注。
- **批号追溯**：按批号片段检索，行内直接展示该批次的领用明细。
- **前后对照**：滑块拖动联看修复前后影像，支持缩放与标注泡点，可导出/复制对照说明文本。
