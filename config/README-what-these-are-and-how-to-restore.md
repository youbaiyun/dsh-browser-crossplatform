# 桌面端配置备份

**这三个文件原本不在源码仓库里**，它们在你的用户目录 `~/.dsh/` 下；
**这里放的是脱敏后的模板**。重装或换机器时，源码可以重新 clone，
**但这些配置不会自己回来**——所以单独备份在这里。

**⚠️ 模板里所有机器相关的绝对路径都换成了占位符**，直接用会指向不存在的目录。
先把占位符换成你自己的路径，再复制回去。占位符约定：

| 占位符 | 换成什么 | 示例 |
|---|---|---|
| `<DSH_HOME>` | 你的 dsh 主目录 | Windows `%USERPROFILE%\.dsh`、macOS/Linux `~/.dsh` |
| `<WORKSPACE_DIR>` | 你真的在用的工作区目录 | `%USERPROFILE%\Documents\deepseek-harness` |

对话 id、工作区 id 也换成了 `1111…` / `session-0000…` 这种明显是示例的值：
**不要把这些示例 id 复制回去**，它们只用于让文件结构可读。恢复你自己的状态时，
保留你本机 `~/.dsh/storages/workspace.json` 里的真实 id。

---

## 各个文件是什么

| 备份文件名 | 原来的位置 | 作用 |
|---|---|---|
| `cordis.patch.yml` | `~/.dsh/profiles/desktop/cordis.patch.yml` | **插件配置**：模型、界面选项、技能目录、桥接插件 |
| `profile-package.json` | `~/.dsh/profiles/desktop/package.json` | **装了哪些插件**：列出这个 profile 加载的全部 bundle |
| `workspace-registry.json` | `~/.dsh/storages/workspace.json` | **工作区与对话的分区登记**：每个分区叫什么、里面有哪些对话（模板里 id 已脱敏） |

---

## 关键内容说明

### `cordis.patch.yml`

这个文件是**所有插件配置的落点**。注意它自己第一行就写了：

> 这是一个补丁层，在每个 bundle 之后应用。**不要改 `cordis.yml`，改这个文件。**

**当前包含 7 个条目：**

| id | 作用 |
|---|---|
| `agent-default-model` | 用哪个模型（`deepseek-flash`，reasoningEffort: high） |
| `ui-settings-account` | 账号与用量设置 |
| `ui-chat` | 对话界面（transcriptView / performanceUsage） |
| `ui-settings` | 界面设置（当前 `enabled: false`） |
| `agent-preset-registry` | 默认预设（`cordis`） |
| `user-skill-filesystem` | **挂载技能目录** `<DSH_HOME>\skills` |
| `bridge-browser` | **桥接插件**（`disabled: false`） |

**⚠️ 两个坑：**

1. **插件市场会重写这个文件。** 文件里原有的注释已经警告过：市场重写时中文注释可能变成乱码（只是显示问题，不影响加载）。**如果你发现中文注释乱了，不用管；但如果某个条目不见了，就要从这份备份恢复。**

2. **`bridge-browser` 条目下没有 `config` 段。** 这不是遗漏——不写就等于用默认值：

   ```
   sessionWorkspacePath 默认 = ~/.dsh/browser-sessions
   ```

   也就是浏览器里的对话会归到一个**独立分区**。这一点和 `workspace-registry.json` 对应。

### `profile-package.json`

**当前加载的 bundle 列表：**

```
@deepseek-ai/dsh-base
@deepseek-ai/dsh-web-app              ← 就是这个界面
dsh-cost-meter
dshmarket                             ← 插件市场
@tt-a1i/archify-dsh
dsh-browser-crossplatform        ← 桥接插件(通过 link 指向源码)
@deepseek-ai/dsh-experimental-voice-input-bundle
```

**注意 `dsh-browser-crossplatform` 是一个 `link:` 依赖**，模板里写的是相对占位符：

```
link:.dsh-browser-source
```

**恢复时必须把它改掉**，指向你实际 clone 的仓库里的插件目录（`<你 clone 的仓库>\packages\bridge`），
否则这个 profile 加载的插件链接会断，插件起不来（桌面端会报找不到模块）。
可以用交互式命令让 pnpm 自己写这个链接，避免手改：

```sh
cd <DSH_HOME>\profiles\desktop
pnpm add link:<你 clone 的仓库>\packages\bridge
```

**所以这个 profile 用的是源码目录里的插件，不是一个发布版。** 改源码后必须重新构建 `lib/` 并重启，否则不生效。

（0.38.8 起 `lib/` 把运行时依赖全部内联，只 import `node:*`：`link:` 指向的目录不需要再补
`node_modules`。如果恢复后报 `ERR_MODULE_NOT_FOUND … @deepseek-ai/cosmokit`，说明那份
`lib/` 是内联前构建的旧产物，重建即可；`pnpm --dir packages/bridge run check-bundle`
可以验证。）
（这个 `link:` 的目标是本机状态，所以模板里写的是占位符而不是某个人的目录。）

### `workspace-registry.json`

**当前 4 个分区（模板里的路径与 id 均为占位/示例）：**

| 分区名 | 路径 | 对话数 |
|---|---|---|
| `default-workspace` | `<WORKSPACE_DIR>\default-workspace` | 11 |
| `DSH-file` | `<WORKSPACE_DIR>` | 2 |
| `<WORKSPACE_DIR>\` | `<WORKSPACE_DIR>\` | 0 |
| **`浏览器对话`** | `<DSH_HOME>\browser-sessions` | **5** |

**「浏览器对话」就是浏览器侧边栏里那些对话。** 它的标题本来是 `browser-sessions`（照目录名自动取的，像个内部细节），已手动改成中文。

**⚠️ 这个文件是活状态文件**，程序运行时也会写它。手工改之前先备份。改完**必须重启桌面端**才会生效——界面进程只在启动时读一次，运行中不会重新加载。

**另外还有 12 个对话被列在 `global.archivedSessionIds` 里**（归档了，不在分区列表里显示）。

---

## 怎么恢复

**先退出桌面端**，然后（`<DSH_HOME>` 换成你的实际目录）：

```
cordis.patch.yml          →  <DSH_HOME>\profiles\desktop\cordis.patch.yml
profile-package.json      →  <DSH_HOME>\profiles\desktop\package.json
workspace-registry.json   →  <DSH_HOME>\storages\workspace.json
```

**先改占位符**（三处，缺一个就会指向不存在的目录）：
1. `cordis.patch.yml`：把 `<DSH_HOME>` 换成你的用户目录（技能目录那一行）。
2. `workspace-registry.json`：把 `<WORKSPACE_DIR>` / `<DSH_HOME>` 换成你实际的工作区路径。
3. `profile-package.json`：`link:.dsh-browser-source` **必须改成你 clone 的仓库里的 `packages/bridge`**（见上一节），
   否则 profile 加载不到插件。

**id 占位符不要照抄**——那只是让结构可读。

**然后重装依赖**（profile 的 `node_modules` 不在备份里，有几百 MB，也没必要备份）：

```sh
cd <DSH_HOME>\profiles\desktop
pnpm install
```

**最后重启桌面端。**

---

## 没有备份的东西（故意）

| 没备份 | 为什么 |
|---|---|
| `ext-bridge-token` | **凭据**。它是本机回环连接用的令牌，会重新生成，不该进备份 |
| `.credentials.yaml` | **账号凭据**，同上 |
| `profiles/*/node_modules/` | 几百 MB，`pnpm install` 可以重建 |
| `~/.dsh/sessions/` | 你的**全部对话记录**，体积大且一直在变。要备份的话单独处理 |
| `~/.dsh/browser-sessions/` | 浏览器对话的会话目录（和上面同类） |
| `~/.dsh/cache/`、`.pnpm-store/` | 缓存，可重建 |
