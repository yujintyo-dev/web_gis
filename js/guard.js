/* 管理画面を他のサイトの中に埋め込まれて、気づかないうちに操作させられる(クリックジャッキング)のを防ぐ */
(function () {
  try {
    if (window.top !== window.self) {
      document.documentElement.style.display = 'none';
      window.top.location = window.self.location.href;
    }
  } catch (e) {
    document.documentElement.style.display = 'none';
  }
})();
