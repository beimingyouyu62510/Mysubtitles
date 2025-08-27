一个 Railway 部署用的说明：

# 🎬 Stremio Subtitle Translator Addon

AI 翻译字幕插件，支持：
- ✅ OpenSubtitles 源字幕
- ✅ 自动检测目标语言字幕，没找到才翻译英文
- ✅ 多语言（最多 5 种）
- ✅ 缓存，避免重复翻译
- ✅ 支持 Google 免费/Google Cloud/DeepL

## 🚀 部署

### Railway 一键部署
1. Fork 本项目到你的 GitHub。
2. 在 Railway 新建项目 → 从 GitHub 导入。
3. 配置环境变量：

| 变量名                | 说明                                |
|-----------------------|-------------------------------------|
| `PORT`                | Railway 自动分配，无需手动修改。    |
| `BASE_URL`            | Railway 自动设置，无需手动修改。    |
| `DEFAULT_TO_LANGS`    | 默认翻译语言，逗号分隔（例：`zh-CN,ja`）。 |
| `ENGINE`              | 翻译引擎：`google_free` / `google_cloud` / `deepl` |
| `GOOGLE_API_KEY`      | 可选，Google Cloud Translate API Key |
| `DEEPL_API_KEY`       | 可选，DeepL API Key                 |
| `OPENSUBTITLES_API_KEY` | 必填，OpenSubtitles API Key        |

4. 部署完成后，访问：


https://你的-railway-域名/manifest.json

复制这个地址添加到 Stremio 即可。

---

## 🔑 获取 OpenSubtitles API Key
在 [OpenSubtitles API](https://www.opensubtitles.com/docs/api/html/) 注册账号，申请 API Key。

---

## 📌 使用
- Stremio 打开 → Add-on → 输入 manifest 链接  
- 选择影片 → 字幕 → 选择目标语言（没现成就自动翻译）  

⚠️ 注意

首次翻译会等待 ~30 秒（整集翻译），之后刷新即可使用缓存。

翻译额度有限，推荐优先使用 OpenSubtitles 原始中文字幕。
