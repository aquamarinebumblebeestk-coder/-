# 開発ルール

## HTMLページ
- 新しいHTMLページを作るときは、`<head>` の `<title>` の直後に、以下の「最新版チェック」スクリプトを必ず入れる（既存ページと同じもの）。
  ページを開いたときにサーバに新しい版があれば、自動で読み込み直すためのもの。

```html
<script>
  // サーバに新しい版があれば読み込み直す
  (async () => {
    try {
      const res = await fetch(location.pathname, { cache: 'no-cache' });
      const latest = Date.parse(res.headers.get('last-modified'));
      const key = 'reloaded:' + location.pathname;
      if (latest > Date.parse(document.lastModified) && sessionStorage.getItem(key) != latest) {
        sessionStorage.setItem(key, latest);
        location.replace(location.pathname + '?v=' + Date.now() + location.hash);
      }
    } catch {}
  })();
</script>
```

- 既存ページを編集するときも、このスクリプトを消さない。
- 新しいページを作ったら `index.html` のリンク一覧（`<ul>`）に追加する。

## 作業の進め方
- スクリーンショットを撮って見た目を確認する作業はしない。ユーザーから頼まれたときだけ行う。
- 時刻表など外部の情報が必要なときは、Web検索やサイトへの接続をする前に、ユーザーから資料（画像・ファイル・テキストなど）をもらえないか確認する。
