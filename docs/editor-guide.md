# 帧叙使用说明

## 作品从创建到发布

1. 解压整个 Windows 便携包，在有写入权限的目录运行 `FrameForge.exe`。点击作品菜单的「新建作品」可设置名称与保存目录。
2. 将视频、图片和音频导入创作资源。把视频或图片拖入画布，或绑定到现有节点。
3. 在故事大纲添加章节，给有内容的章节设置起点。游戏从列表第一章的起点开始。节点可跨章跳转，运行状态会沿用。
4. 在节点检查器设置媒体与故事内容，添加选项、条件和节点事件。在「游戏数据」定义属性与道具。条件分支按排列顺序选择第一个满足条件的出口，建议保留一个无条件出口。
5. 双击视频节点打开时间线。可拼接和裁剪视频、图片与音轨，调整开始位置、音量和淡入淡出。交互和事件时间以整个节点为基准。
6. 按 **F5** 试玩。也可以从指定章节或节点进入，查看运行属性、道具与事件记录。改变选项、规则后建议重走受影响的路线。
7. 用 **Ctrl+S** 保存。移动工程时，复制整个目录，保留相对路径。打开较早的工程时，帧叙会尝试迁移到当前格式。

### 按键

| 操作 | Windows |
| --- | --- |
| 保存、另存为、打开 | Ctrl+S、Ctrl+Shift+S、Ctrl+O |
| 撤销、重做 | Ctrl+Z、Ctrl+Shift+Z |
| 复制选中节点 | Ctrl+D |
| 拖动画布 | 空格加拖动，或鼠标中键 |
| 试玩 | F5 |
| 试玩或游玩临时加速 | 按住 Ctrl |
| 时间线播放、分割、删除 | Space、B、Delete |

## 导出与部署

- **Windows 游戏**生成独立播放器和资源目录。游玩时运行作品的 exe，分发时保留整个目录。
- **网页版游戏**生成 `index.html`、`assets/`、`game/project.json`、`game/files/` 与部署说明。浏览器开发预览以 ZIP 下载，桌面版输出目录。上传整个目录到 HTTP(S) 静态服务即可，可以部署在站点子路径。浏览器的存档保存在当前站点数据中。
- 使用浏览器支持的编码，如 H.264/AAC MP4。导出直接复制媒体，推荐服务器支持视频 Range 请求。网页播放器需要 HTTP(S) 环境。
- 桌面环境可安装 FFmpeg / ffprobe，增强媒体信息与缩略图提取。便携发行使用 Windows x64，未签名。

## 创作 Agent 与模型设置

左下角「设置 → 模型设置」可设置默认模型、API 密钥来源、服务地址，并测试连接。模型调用可能计入供应商额度。手动输入的密钥通过 Electron 系统加密保存。应用会把请求发送到配置的服务商。应用配置与 Agent 会话在本地，作品工程及游戏导出不携带这些数据。

| 服务商 | 密钥或登录 |
| --- | --- |
| OpenAI | `OPENAI_API_KEY` |
| Gemini | `GEMINI_API_KEY` 或 `GOOGLE_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| MiniMax | `MINIMAX_API_KEY` |
| Codex CLI | 本机安装后运行 `codex login`，在帧叙设置内自动查找或选择程序 |
| 豆包 TTS | `DOUBAO_TTS_API_KEY` 或 `DOUBAO_API_KEY` |

Gemini 的新配置默认使用 `https://generativelanguage.googleapis.com/v1beta` 和 `gemini-4-hydrogen`。如果有兼容的本机代理，可在「高级设置」填写其接口地址。已有的保存配置继续按原设置运行。修改环境变量后需要重启应用。模型、可用地区和用量以供应商为准。 [Gemini API 模型列表](https://aistudio.google.com/docs/models)

Codex CLI 需要支持动态工具与禁用原生环境的 app-server 协议。图像生成通过桌面版配置的 Codex CLI 或 MiniMax 提供，语音能力通过配置的豆包 TTS 提供。相关限制和扩展步骤见[创作 Agent 架构](https://github.com/Sheldon23357/FrameForge/blob/main/docs/agent-architecture.md)。

## 浏览器开发预览

浏览器版可编辑、试玩、保存或打开工程 ZIP、导出 HTML5 游戏。桌面版提供原生目录管理、Windows 游戏打包与真实模型调用。浏览器内的自动恢复和素材缓存在当前浏览器的站点数据中，建议定期保存工程 ZIP。
