# QQ Music plugin for MyGo Music

在 MyGo Music 的“设置 > 插件”中，通过右上角“+ > 从文件夹…”选择 `dist` 文件夹安装。

直接连接 QQ 音乐，无需另行启动服务。

登录默认使用手机 QQ 扫码。在插件设置的“扫码登录方式”中输入“微信”并提交，再点击登录，可以使用微信扫码；留空或填其他内容仍然是 QQ 扫码。该设置是普通文本框，不是下拉选项（MyGo Music 的插件设置只支持 `key` / `label` / `help`）。

登录凭据以明文保存在本机 MyGo Music 的插件数据中，并非系统密钥链。退出登录会删除本地凭据，但不会撤销 QQ 服务器上的登录会话。

支持 QQ 返回的逐字歌词和翻译，缺少逐字数据时回退至 LRC。支持搜索、推荐歌单、排行榜、听书（有声书）、专辑、歌手、歌单详情、评论（只读）、收藏歌曲、收藏歌单、收藏专辑、自建歌单增删改和私人电台。目前不支持收听历史、关注歌手和发表评论。歌曲能否完整播放由 QQ 音乐的版权、账号及地区限制决定，插件不会绕过权限。

## 0.5.1

- 修复“收藏的专辑”整页报 `json: cannot unmarshal number into Go struct field AlbumList.albums.0.released of type string`：QQ 收藏接口的 `release_time` 是数字（unix 秒或 `YYYYMMDD`），而播放器的 `Album.Released` 是字符串。现在统一经 `releasedOf()` 转成 `YYYY-MM-DD`，日期按北京时间取；`name`、`artists.name`、`imageUrl` 也一并强制为字符串，避免同类整页崩溃。
- 搜索接口回 `2001`（QQ 限流）时统一重试两次，`search`、`searchPlaylists`、听书搜索都走同一个 `retrying()`。

## 0.5.0

- 新增“听书”页：QQ 音乐的长音频是有声书专辑，`search_type 15` 才返回它们（`2` 只返回唱片专辑）；侧边栏多了“听书”入口，页内是热门听书、8 个分类和有声小说，每个分类是一页 30 张有声书专辑。
- 有声书的剧集就是歌曲，点进专辑走 `album`、播放走 `stream`，与普通专辑同一条链路；单张专辑最多显示 1000 集（QQ 专辑接口上限）。
- QQ 的搜索接口偶尔回 `2001`（限流），听书页对这种情况重试两次；首页的两个搜索串行发出，避免并发被限流。

## 0.4.0

- 修复匿名搜索：`DoSearchForQQMusicDesktop` 现在在 `comm` 中带上 `tmeAppID`，否则 QQ 返回 `code=2001`、搜索结果为空。
- 逐字歌词的 QRC 解码器拆到 `qrc-lyrics.js`，pako 改为正常依赖导入（由 `build.mjs` 打包），不再在 `index.js` 里内联一份压缩后的 pako。
- `plugin.json` 去掉播放器不认识的 `settings[].options` 与 `helpForText`，并补齐封面域名到 `permissions.network`。

## 致谢

本插件基于 [@Amamiya23](https://github.com/Amamiya23) 的 [mygo-music-qq-plugin](https://github.com/Amamiya23/mygo-music-qq-plugin)（0.3.0）修改而来：登录（QQ / 微信扫码）、浏览、歌单与收藏、逐字歌词 QRC 解码等主体实现均出自上游。感谢上游作者把 QQ 音乐的协议细节整理成可直接运行的插件。

上游之外的改动见上面的版本记录（0.4.0 修匿名搜索、拆分 QRC 模块；0.5.0 加听书）。

## 开发

运行 `npm test` 执行离线协议测试；修改源码后运行 `npm run build` 重新生成安装目录。
