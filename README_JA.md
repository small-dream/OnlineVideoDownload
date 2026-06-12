<p align="center">
  <img src="icons/icon128.png" alt="Online Video Downloader" width="80" height="80">
  <h1 align="center">Online Video Downloader</h1>
  <p align="center">
    ウェブページ内のオンライン動画を自動検出＆ワンクリックダウンロード<br>
    <strong>YouTube</strong> · <strong>Bilibili</strong> · <strong>HLS</strong> · <strong>DASH</strong> · <strong>Blob</strong> · <strong>MP4</strong>
  </p>
  <p align="center">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT">
    <img src="https://img.shields.io/badge/Chrome-88%2B-green.svg" alt="Chrome 88+">
    <img src="https://img.shields.io/badge/Manifest-V3-purple.svg" alt="Manifest V3">
  </p>
  <p align="center">
    <a href="README.md">中文</a> · <a href="README_EN.md">English</a> · <strong>日本語</strong> · <a href="README_FR.md">Français</a>
  </p>
</p>

---

## ✨ 主な特徴

- 🎬 **自動検出** — 任意のページの動画リソースを自動識別。URLの手動貼り付け不要
- ⬇️ **ワンクリックダウンロード** — ボタン一つで動画を保存、操作はシンプル
- 🔀 **ブラウザ内マージ** — YouTube 1080p+、Bilibili DASH の音声・映像ストリームをブラウザ内で自動結合。**ffmpeg やローカルツールのインストール不要**
- 🌐 **幅広い対応** — YouTube・Bilibili の専用サポートに加え、任意のサイトの HLS / DASH / MP4 / Blob 動画に対応
- 🔒 **プライバシー保護** — すべての処理はローカルで完結、サードパーティサーバーへのデータ送信なし
- 🛡️ **DRM 尊重** — 暗号化コンテンツは検出してフラグを表示するのみ、保護のバイパスは行いません

---

## 🚀 クイックスタート（30秒）

> **前提条件**: Chrome 88+ または Edge 88+

### ステップ 1: コードを取得

```bash
git clone https://github.com/small-dream/OnlineVideoDownload.git
```

または ZIP をダウンロードして展開。

### ステップ 2: 拡張機能を読み込む

1. Chrome を開き、アドレスバーに `chrome://extensions` と入力
2. 右上の **「デベロッパーモード」** スイッチをオンにする
3. **「パッケージ化されていない拡張機能を読み込む」** をクリック
4. プロジェクトのルートディレクトリ（`manifest.json` があるフォルダ）を選択

✅ 完了！ツールバーに拡張機能アイコンが表示されます。

---

## 📖 使い方ガイド

### 基本：動画をダウンロードする

1. **動画のあるページを開く**（例：YouTube の動画ページ）
2. 動画プレイヤーが読み込まれるのを待つ — 拡張機能が自動的に動画を検出します
3. ツールバーの **拡張機能アイコンをクリック** すると、検出された動画一覧が表示されます
4. ダウンロードしたい動画を見つけて **「ダウンロード」** ボタンをクリック
5. 下部のプログレスバーでリアルタイムのダウンロード状況を確認

> 💡 **ヒント**: 拡張機能をインストール後、アクセスしたページの動画はすべて自動検出されます。アイコンをクリックするだけで確認できます。

### YouTube ダウンロード

| 解像度 | 動作 |
|--------|------|
| ≤ 720p | 直接ダウンロード（音声付き結合ストリーム） |
| 1080p+ | 映像 + 音声ストリームを自動ダウンロードし、ブラウザ内で結合 |

- YouTube 動画ページを開く → 拡張機能アイコンをクリック → 解像度を選択 → ダウンロード
- **キャプチャモード**（ブラウザで読み込まれたストリームを取得）と **パースモード**（独立してストリーム情報を取得）をサポート
- パースモードでは解像度を選択可能：1080p、720p、480p など

### Bilibili ダウンロード

- ブラウザで **Bilibili アカウントにログイン** している必要があります（未ログインでは360Pのみ）
- Bilibili 動画ページを開く → 拡張機能アイコンをクリック → 画質を選択 → ダウンロード
- **最高画質を自動選択**、または手動で画質を指定可能
- 画質設定は保存され、次回のダウンロードでも適用されます
- プレミアムコンテンツにはプレミアムアカウントが必要です

### HLS ストリーム / .m3u8 動画

- HLS プロトコルを使用したライブ配信やVODの場合、すべての TS セグメントを自動ダウンロード
- ブラウザ内でセグメントを結合し、単一の `.ts` ファイルとして保存
- **AES-128 暗号化ストリーム** の自動復号に対応
- ダウンロード中はセグメントの進捗を表示：`45/120 セグメント完了`

### Blob URL / MSE 動画

- 一部のウェブサイトでは MediaSource API を使用して動画を再生（`blob:` で始まる URL）
- 拡張機能がメモリ内の動画データを自動的にインターセプトしてキャプチャ
- Content Script 経由でリレーしてダウンロードを完了

---

## 🎨 動画タイプラベル

ポップアップパネルでは、各動画タイプが色分けされたラベルで表示されます：

| ラベル | タイプ | 説明 |
|--------|--------|------|
| 🟢 **MP4** | ダイレクトリンク | 直接ダウンロード |
| 🔴 **HLS** | M3U8 ストリーム | ブラウザ内でセグメント結合後にダウンロード |
| 🟡 **DASH** | MPD ストリーム | MPD をダウンロードまたは音声/映像を結合 |
| 🔴 **YouTube** | YouTube 動画 | ≤720p は直接、1080p+ は自動結合 |
| 🔵 **B站** | Bilibili 動画 | API 経由で取得 + 自動結合 |
| 🟣 **Blob** | MSE メモリ | Content Script リレーダウンロード |
| ⬛ 🔒 **DRM** | 暗号化コンテンツ | ダウンロード不可、フラグ表示のみ |

---

## 📋 対応フォーマット＆サイト

### 汎用フォーマット（任意のウェブサイト）

| フォーマット | 説明 |
|-------------|------|
| MP4 / WebM / FLV / MKV / M4V | ダイレクトリンク、ワンクリックダウンロード |
| HLS (.m3u8) | AES-128 暗号化ストリームの復号と結合に対応 |
| DASH (.mpd) | マニフェストをダウンロード、または音声/映像ストリームを結合 |
| Blob URL | MediaSource のメモリ内動画をインターセプト |

### 専用サポート

| サイト | 対応機能 |
|--------|----------|
| **YouTube** | 結合 + アダプティブストリーム、SPA ルーティング対応、解像度選択 |
| **Bilibili** | WBI 署名、DASH/FLV デュアルフォーマット、多パート動画、画質選択、CDN Referer インジェクション |

### 既知の制限

- **DRM 暗号化コンテンツ**（Netflix、Disney+ など）— Widevine/PlayReady により復号データにアクセス不可
- **ログインなしの有料コンテンツ** — 対応するウェブサイトにログインしてください

---

## 🏗️ アーキテクチャ

```
Chrome Extension (Manifest V3)
│
├── background/                    Service Worker
│   ├── service-worker.js          メッセージルーティング + ダウンロード完了監視 + マージトリガー
│   ├── video-registry.js          検出済み動画のメモリレジストリ
│   ├── request-interceptor.js     webRequest ネットワークリスナー
│   ├── downloader.js              ダウンロードスケジューラ（MP4/HLS/DASH/YouTube/Bilibili）
│   ├── hls-fetcher.js             HLS セグメントダウンロード、AES 復号、メモリ内マージ
│   └── header-injector.js         リクエストヘッダーインジェクション
│
├── content/                       Content Script（DOM アクセス可能）
│   ├── content-main.js            エントリポイント：ページスクリプト注入 + ストラテジー組み立て
│   ├── message-router.js          popup / background / page メッセージルーティング
│   ├── progress-reporter.js       ページ内タスク進捗レポート
│   └── strategies/                プラットフォーム別ダウンロードストラテジー
│
├── injected/                      ページコンテキストスクリプト
│   ├── page-context-script.js     メインコントローラー
│   ├── page-interceptor.js        XHR / Fetch / MediaSource / DRM フック
│   ├── page-youtube-parser.js     YouTube ストリームパーサー
│   ├── page-bilibili-parser.js    Bilibili ストリームパーサー
│   └── page-http-utils.js         ページ内 HTTP ユーティリティ
│
├── lib/                           共通ユーティリティライブラリ
│   ├── hls-pipeline.js            HLS パース＆処理パイプライン
│   ├── mpd-parser.js              DASH MPD パーサー
│   ├── wbi-signer.js              Bilibili WBI 署名アルゴリズム
│   ├── bilibili-muxer.js          Bilibili FLV ミュキサー
│   ├── mp4-muxer.js               MP4 ミュキサー
│   └── ...                        その他ユーティリティモジュール
│
└── popup/                         拡張機能ポップアップ UI
    ├── popup.html
    ├── popup.js
    └── popup.css
```

詳細なインターフェースドキュメントは [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) を参照してください。

---

## ❓ よくある質問

<details>
<summary><strong>ポップアップに動画が検出されない？</strong></summary>

- ページに実際に動画コンテンツがあることを確認してください（一部のページでは iframe 経由で動画が読み込まれる場合があり、現在のバージョンでは iframe 内はスキャンしません）
- ページを更新して再度検出を試みてください
- F12 → コンソールを開き、`[OVD]` プレフィックスのエラーがないか確認してください

</details>

<details>
<summary><strong>YouTube は 720p までしかダウンロードできない？</strong></summary>

- 720p 以下は音声を含む結合ストリームのため、直接ダウンロード可能です
- 1080p 以上は映像と音声の別々のストリームをダウンロードし、ブラウザ内で結合する必要があります
- ネットワークが安定していることを確認してください。結合には両方のストリームの完全なダウンロードが必要です

</details>

<details>
<summary><strong>マージに失敗する？</strong></summary>

- ページを更新してリトライしてください。ネットワークが安定していることを確認
- F12 → コンソールで `[OVD]` エラーログを確認
- 特定の動画のみ失敗する場合、元のストリームフォーマットが特殊か、一時的に利用不可の可能性があります
- YouTube / Bilibili のストリーミングは自動リトライに対応。サーバーが `Range` をサポートする場合、中断地点から再開可能です

</details>

<details>
<summary><strong>Bilibili のダウンロードに失敗する？</strong></summary>

- Bilibili アカウントにログインしていることを確認してください
- 選択した画質が利用できない場合、利用可能な最高画質に自動的にフォールバックします
- Bilibili の API 署名アルゴリズムはアップデートで変更される場合があります。継続的に失敗する場合は Issue を提出してください

</details>

<details>
<summary><strong>ダウンロードした HLS ファイルの再生方法は？</strong></summary>

- `.ts` ファイルは VLC、PotPlayer、mpv で直接再生可能です
- ffmpeg で変換も可能：`ffmpeg -i input.ts -c copy output.mp4`

</details>

---

## 🤝 コントリビュート

Issue や Pull Request を歓迎します！開発環境のセットアップやコード規約については [CONTRIBUTING.md](CONTRIBUTING.md) をご覧ください。

```bash
# プロジェクトをクローン
git clone https://github.com/small-dream/OnlineVideoDownload.git

# テストを実行
npm test
```

---

## 📄 ライセンス

このプロジェクトは [MIT License](LICENSE) のもとで公開されています。

---

## ⚠️ 免責事項

このツールは教育および個人使用の目的のみに提供されています。お住まいの地域の法律・規制および各動画プラットフォームの利用規約を遵守してください。アクセス権のあるコンテンツのみをダウンロードしてください。作者はいかなる誤用についても責任を負いません。
