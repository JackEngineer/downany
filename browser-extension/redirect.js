/** redirect.html：把 ?url= 转成 downany:// 深链打开本机下载器。 */
(function () {
  "use strict";
  var params = new URLSearchParams(location.search);
  var pageUrl = params.get("url") || "";
  if (!/^https?:\/\//i.test(pageUrl)) {
    document.body.textContent = "无效链接";
    return;
  }
  location.href = "downany://add?url=" + encodeURIComponent(pageUrl);
})();
