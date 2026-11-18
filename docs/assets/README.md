# 文档素材说明

[文档总览](../README.md) · [验收记录](../DOCS-REVAMP-VERIFICATION.md)

## 首页实机导览

封面 `mascot/hero.webp` 复用鲸鱼娘举场记板、项目名居中的原版插画。三格概念漫画 `mascot/creator-stories.webp` 使用内置 ImageGen 绘制，参考同一角色的待机帧与原封面。画面依次表现选定稿件、为分镜配参考图和按导演手册检查表演，配合首页的脚本与分镜介绍。

七张实机导览图存放在 `guided-tour/`。鲸鱼娘从左上探入截图，指向真实操作区。截图保留实际按钮、数据与连线；图中上方的大字是导览图注。点击首页导览图可放大相应实机原图。

| 文件 | 实机内容 |
| --- | --- |
| `overview.webp` | 咖啡店项目的会话、已进入的制作阶段、画布与首帧连线 |
| `start-project.webp` | 会话工作流栏内的短视频生产阶段与选题策划入口 |
| `open-drama.webp` | 实机顶栏和会话输入区的 Drama 入口，两处局部来自同一截图 |
| `handoff.webp` | 左侧是 9:16、20 秒已保存的制作规格，右侧是选题到内容分析的交接预览 |
| `first-frame.webp` | 图片入边、图生视频节点和节点内的完整提示词 |
| `video-result.webp` | 已完成的生成任务、4 秒本地演示样片及结果节点 |
| `skill-bindings.webp` | 左侧为拍摄脚本制作绑定的 `cafe-shooting-script`，右侧为应用该 Skill 的示例阶段产物 |

四枚小标题头像 `icon-greeting.webp`、`icon-story.webp`、`icon-canvas.webp`、`icon-skill.webp` 裁自已有的引导、递稿、导演和改稿透明角色。三枚本地 SVG 徽标展示 Windows x64、DeepSeek Harness 和代码许可证。宿主徽标的光标短暂明暗变化，独立图片 `workflow.svg` 的光点沿制作方向短暂移动。README 用 `<picture>` 选择带 CSS 的 SVG；操作系统选择减少动态效果，或阅读器只显示默认图片时，使用相应的 `*-still.png` 静帧。所有文字、箭头和操作链接均可在静态画面读取。

<details>
<summary>本轮三格漫画的制作提示词</summary>

为 DSH My Drama Studio 的 GitHub 产品宣传手册制作一张精致的横向电影分镜插画，极宽 3:1 或 2.8:1，全宽彩色，无任何文字字母数字、无界面。图一是中文社区 dsh-pet 的鲸鱼娘人设，图二是既有的产品主视觉作为画风参照。务必保留同一位蓝眼、深蓝长卷发、白色褶边头饰、鲸鳍耳、两头身 Q 版女仆鲸鱼娘与围裙小鲸鱼标志。画三格相连、等宽取景的幕后故事，像杂志中的大开本原画，三格的主体都靠近各自中心，前景可用细斜切边过渡，背景连贯。

左格：暖光咖啡馆桌上好几叠写满抽象线条的不同版本稿纸，鲸鱼娘拿起其中一份在纸上贴上朱红签角、将其交给画外接稿的手，姿势利落。中格：同角色戴导演耳机，在咖啡师和顾客为一杯奶泡拍证件照的分镜板旁，把这张咖啡杯参考照片夹到一个镜头格上，蓝色夹子，叙事清楚。右格：同角色举起一本有鲸尾印章的厚剧本手册，用铅笔勾选一项，身旁有一张简笔的演员动作练习草图。场记灯暖金，靛蓝、奶油色，细腻柔和印刷颗粒，粗细变化的漫画笔触，丰富但有留白，趣味而专业，画面有不同的远近和视角。这是概念漫画，不出现任何屏幕按钮、软件界面、网页、徽标墙、英文标题或对话框。

</details>

## 鲸鱼娘角色来源

角色原型「溟月」由上善无形创作，DeepSeek 女仆鲸鱼娘版本由 ZipZipPipe 设计。主要视觉参考是 PC2005-cloud 的 `dsh-pet` 待机动画，取 [fb38ce6 的待机预览](https://github.com/PC2005-cloud/dsh-pet/blob/fb38ce620576f5ed3735a99536d2b1a4a9eb313f/dsh-pet/assets/preview/daiji-huxi-xiuxian.gif) 首帧作为角色参考。首页用内置 ImageGen 绘制开场引导、递稿、指向首帧和持剧本修改四个透明角色，再把角色与真实截图排版合成。来源见 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet#许可)、[上善无形](https://space.bilibili.com/4456176)、[ZipZipPipe 授权声明](https://www.bilibili.com/opus/1247156596114456581)。

鲸鱼娘插画及含角色的导览图按 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans) 标注。使用时保留角色与参考来源署名，二创限非商业并使用相同许可。仓库 [LICENSE](../../LICENSE) 适用于代码。鲸鱼娘是社区形象。

`mascot/` 中的 `welcome.webp`、`writer.webp`、`director.webp`、`assets.webp`、`troubleshooting.webp` 和 `completed.webp` 是独立的用户指南插画，延续两头身比例、深蓝卷发、鲸鳍耳、白色褶边头饰和带小鲸图案的围裙。

## 真实界面截图

在 Windows 10 x64、DeepSeek Harness Desktop `0.2.1-rc.3` 启动的 **DSH Web** 中，从已安装的 `0.1.0` 候选包采集，源码提交为 `22cfbeb`。专用演示项目为「咖啡店轻喜剧」。对话用本地确定性测试模型，咖啡店首帧用 ImageGen 制作。设置中的秘塔演示渠道使用占位凭据。结果图中的 MP4 由同一参考图在本地制作推近运动，工作台实际提交给回环测试服务、查询、下载并播放该样片。

| 文件 | 展示内容 |
| --- | --- |
| `workspace.webp` | 工作区、会话、当前阶段与画布全景 |
| `install-launch.webp` | 实装插件后在会话打开 Drama Canvas |
| `production-settings.webp` | 制作设置及 9:16、20 秒已保存状态 |
| `workflow.webp` | 短视频生产与选题策划入口 |
| `handoff.webp` | 选题到内容分析的交接预览、固定产物版本及确认入口 |
| `channels.webp` | 视频渠道列表与测试连接入口 |
| `providers.webp` | 通过模板保存的 MiniMax H3 预设与模型方式 |
| `canvas.webp` | 首帧图片、有效连线及内联完整提示词 |
| `generation-confirmation.webp` | 提交前的模型、渠道和参数 |
| `canvas-result.webp` | 完成状态、视频结果节点与回放 |
| `skill-copy.webp` | 复制 Skill 时填写新名称的表单 |
| `skill-edit.webp` | 可打开、复制路径和刷新的 Skill 详情操作区 |
| `skill-bindings.webp` | 保存自定义覆盖后的阶段绑定界面 |
| `skill-output.webp` | 自定义 Skill 激活后保存的拍摄脚本阶段产物 |

更新教程图时，从独立工作区及隔离 DSH Home 启动，记录包、提交和宿主版本。截图可裁切压缩，保留实际界面。对外使用前，检查真实密钥、访问令牌、私人目录和素材是否均已排除。历史实拍资料见 [UI/UX V2](../UIUX-V2.md)。
