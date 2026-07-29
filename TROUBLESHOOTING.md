# 常见问题解决方案

## YouTube 搜索失败 (HTTP 412 错误)

### 问题描述
搜索 YouTube 时出现 `HTTP Error 412: Precondition Failed` 错误。

### 原因
YouTube 的反爬虫机制检测到了自动化请求。

### 解决方案

#### 方案 1: 使用代理（推荐）

1. 打开"设置"标签页
2. 勾选"启用代理"
3. 输入代理地址，例如：`http://127.0.0.1:7890`
4. 点击"保存设置"
5. 重新尝试搜索

#### 方案 2: 使用 Cookies

1. 在浏览器中登录 YouTube
2. 导出 cookies 到文件（可以使用浏览器插件如 "Get cookies.txt"）
3. 将 cookies.txt 文件放到项目根目录
4. 修改配置以使用 cookies（需要手动修改代码）

#### 方案 3: 降低请求频率

1. 不要频繁搜索
2. 每次搜索间隔至少 5-10 秒
3. 减少搜索结果数量

#### 方案 4: 直接使用下载功能

如果搜索功能不可用，可以：
1. 在浏览器中搜索视频
2. 复制视频链接
3. 在"下载"标签页直接粘贴链接下载

### 临时解决方案

如果以上方案都不行，可以尝试：

1. **更新 yt-dlp**
   ```bash
   source venv/bin/activate
   pip install --upgrade yt-dlp
   ```

2. **使用 VPN**
   - 使用 VPN 更换 IP 地址
   - 在设置中配置 VPN 的代理地址

3. **等待一段时间**
   - YouTube 的限制可能是临时的
   - 等待几小时或一天后再试

## YouTube 下载失败 / 只有低画质（JS challenge）

### 问题描述
YouTube 下载报 `Requested format is not available`，或只能下到 360p 低画质；
日志中有 `Signature solving failed` / `n challenge solving failed` 警告。

### 原因
YouTube 要求执行 JS challenge（nsig/signature）才放行完整格式。yt-dlp 通过
EJS remote components 下载 solver 脚本，并调用本机 JS 运行时（deno）求解。
应用已默认开启 `remote_components: ["ejs:github"]`（见 `src/core/ytdlp_opts.py`），
缺少的是本机的 deno 运行时。

### 解决方案
1. 安装 deno：`brew install deno`（或参考 https://deno.land 官方安装方式）
2. 确认 yt-dlp 为最新：`pip install --upgrade yt-dlp`
3. 首次解析需联网下载 solver 脚本（自动完成，缓存在 yt-dlp 缓存目录）
4. 未安装 deno 时不会报错中断，但会自动退化为免签名低画质格式

## 下载进度显示错误

### 问题描述
下载时出现 `could not convert string to float` 错误。

### 解决方案
已在最新版本中修复：
- 添加了 `no_color: True` 配置
- 添加了 ANSI 代码清理逻辑
- 添加了错误处理

如果仍然出现问题，请重启应用。

## Bilibili 搜索

Bilibili 搜索通常比 YouTube 更稳定，建议优先使用 Bilibili 搜索功能。

## 其他问题

### 下载速度慢
1. 检查网络连接
2. 在设置中取消速度限制
3. 增加并发下载数（但不要超过 5）

### 下载失败
1. 检查视频链接是否有效
2. 检查是否需要登录（某些视频需要会员）
3. 尝试使用代理
4. 查看错误日志获取详细信息

### FFmpeg 相关错误
1. 确保已安装 FFmpeg：`./scripts/install_ffmpeg.sh`
2. 检查 FFmpeg 是否可执行：`./bin/ffmpeg -version`
3. 如果使用系统 FFmpeg，确保在 PATH 中

## 联系支持

如果问题仍未解决，请：
1. 查看日志文件获取详细错误信息
2. 在 GitHub 上提交 Issue
3. 提供错误日志和复现步骤
