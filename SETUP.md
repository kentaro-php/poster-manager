# セットアップ手順

このアプリを動かすには、以下の3つのサービスを連携させます：

1. **Google スプレッドシート + Apps Script**（データの保存＆API）
2. **Cloudflare R2 + Worker**（写真ストレージ）
3. **GitHub Pages**（フロントエンド公開）

合計で **30分〜45分** で構築できます。

---

## ステップ1: Google スプレッドシートのセットアップ（10分）

### 1-1. スプレッドシートを作成

1. https://sheets.google.com/ にアクセス
2. 「空白」を選択して新規スプレッドシート作成
3. 左上のタイトルを **「ポスター管理DB」** に変更

### 1-2. Apps Script を設定

1. メニューバーの **拡張機能 > Apps Script** をクリック
2. 開いたエディタで `Code.gs` の中身を全部削除
3. 当プロジェクトの `google-apps-script.js` の内容を貼り付け
4. 左の💾保存アイコン または `Ctrl+S` (Mac: `Cmd+S`) で保存

### 1-3. シート初期化

1. Apps Scriptエディタ画面で関数の選択を **`testInit`** に変更
2. **▶ 実行** ボタンをクリック
3. 初回は権限承認画面が出るので承認
   - 「権限を確認」→ Googleアカウント選択
   - 「Advanced」 →「Go to (プロジェクト名) (unsafe)」をクリック
   - 「許可」をクリック
4. スプレッドシートに戻ると `posters` シートが追加され、ヘッダー行が作られている

### 1-4. Webアプリとしてデプロイ

1. Apps Scriptエディタ右上の **デプロイ** > **新しいデプロイ**
2. 種類: **ウェブアプリ** を選択
3. 設定:
   - 説明: `poster-manager`
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**（重要）
4. **デプロイ** をクリック
5. 表示される **「ウェブアプリのURL」** をコピーして控えておく
   - 例: `https://script.google.com/macros/s/AKfycbz.../exec`

---

## ステップ2: Cloudflare R2 + Worker のセットアップ（15分）

### 2-1. R2 を有効化

1. https://dash.cloudflare.com/ にログイン
2. 左メニュー **R2 Object Storage** をクリック
3. 初回は支払い情報の登録が必要（無料枠で済むが、登録は必要）
   - 月間 10GB ストレージ・100万リクエストまで無料

### 2-2. R2 バケット作成

1. **Create bucket** ボタンをクリック
2. Bucket name: **`poster-photos`**
3. Location: 自動 または「Asia-Pacific」
4. **Create bucket** をクリック

### 2-3. パブリックアクセスを有効化

1. 作成したバケットを開く
2. **Settings** タブ
3. **Public access** セクションの **Allow Access** をクリック
4. R2.dev サブドメインの公開URLが表示される
   - 例: `https://pub-xxxxxxxxxxxx.r2.dev`
   - このURLを控えておく

### 2-4. Worker（写真アップロード用）作成

1. 左メニュー **Workers & Pages** > **Compute**
2. **Create** > **Create Worker**
3. Worker名: **`poster-photo-upload`**
4. **Deploy** をクリック（Hello World が動く）

### 2-5. Worker コードを書き換え

1. デプロイ後 **Edit code** をクリック
2. エディタの中身を全削除
3. プロジェクトの `photo-upload-worker.js` の内容を貼り付け
4. **重要**: コード内の `PUBLIC_BASE_URL` を、ステップ2-3で取得したR2公開URLに書き換える
   ```javascript
   const PUBLIC_BASE_URL = 'https://pub-xxxxxxxxxxxx.r2.dev';
   ```
5. **Deploy** をクリック

### 2-6. R2 バケットを Worker にバインド

1. Workerの編集画面を閉じてWorker詳細画面に戻る
2. **Settings** タブ > **Bindings** > **Add binding**
3. Type: **R2 Bucket**
4. Variable name: **`PHOTOS`**（コードと一致させる）
5. R2 bucket: **`poster-photos`** を選択
6. **Save and Deploy**

### 2-7. Worker URLを控える

Worker詳細画面に表示される URL をメモ：
- 例: `https://poster-photo-upload.kentaro-php.workers.dev`

### 2-8. 動作確認

ブラウザで `{Worker URL}/` にアクセス。JSONヘルプが表示されればOK。

---

## ステップ3: GitHub Pages 公開（5分）

### 3-1. リポジトリ作成

1. https://github.com/new で新規リポジトリ作成
2. Repository name: **`poster-manager`**
3. Public 推奨（公開URLでアクセスする方式のため）
4. **Create repository**

### 3-2. ファイルをアップロード

ターミナルで：

```bash
cd ~/Downloads/poster-manager
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/kentaro-php/poster-manager.git
git push -u origin main
```

### 3-3. GitHub Pages 有効化

1. https://github.com/kentaro-php/poster-manager/settings/pages
2. Source: **Deploy from a branch**
3. Branch: **main** / **/ (root)**
4. **Save**
5. 数分後、`https://kentaro-php.github.io/poster-manager/` で公開される

---

## ステップ4: 初回アクセス・設定（2分）

1. 公開URL https://kentaro-php.github.io/poster-manager/ を開く
2. **初回設定モーダル**が表示される
3. 入力：
   - スタッフ名: `けんたろう`
   - Apps Script URL: ステップ1-4 でコピーしたURL
   - 写真アップロード Worker URL: ステップ2-7 でコピーしたURL
4. **設定を保存して開始** をクリック

---

## ステップ5: スタッフへの共有

スタッフに以下を共有：

1. **公開URL**: https://kentaro-php.github.io/poster-manager/
2. **Apps Script URL**: ステップ1-4 で取得したURL
3. **写真アップロード Worker URL**: ステップ2-7 で取得したURL（任意）
4. **自分のスタッフ名**: 各自の名前を入力してもらう

スタッフはスマホでURLを開いて初回設定を済ませれば、そのまま使えます。

### スマホのホーム画面に追加（推奨）

iPhone Safari で開いて：
1. 共有ボタン → **ホーム画面に追加**
2. 名前は「ポスター管理」などに

これでアプリのように起動できます。

---

## 運用上の注意

### CSV インポート

Excelでフォーマットする際の注意：

- 1行目はヘッダー、2行目以降がデータ
- 必須カラム: `address`
- カラム名は英語で固定: `id`, `address`, `lat`, `lng`, `provider_name`, `phone`, `count`, `status`, `installed_at`, `notes`, `photo_urls`, `updated_at`, `updated_by`
- `id` を空にすると自動採番（P001形式）
- `lat` `lng` がないと地図に出ないので、可能な限り入力推奨
- 詳細は `poster-template.csv` を参照

### バックアップ

スプレッドシートそのものが原本になります。Googleドライブが自動でバックアップ。
気になる場合は、月1回くらい **ファイル > ダウンロード > CSV** で手元にも保存。

### スタッフのアクセス管理

- 「公開URLを知っている人だけ」方式
- スタッフを外したい場合: GitHub Pagesの設定でPrivateにする等の対応が必要
- 重要度が上がったら、認証付き（Cloudflare Access等）への移行を検討

### 写真の容量管理

- R2の無料枠: 10GB
- 1枚 1〜3MB と仮定して、3,000〜10,000枚保存可能
- 容量が気になる場合、定期的にR2バケットから古い写真を削除

---

## トラブルシューティング

### 「データ取得失敗: Failed to fetch」エラー

→ Apps Script の権限・公開範囲を確認。「アクセスできるユーザー: 全員」になっているか。

### CSV インポートが効かない

→ ヘッダー名が英語の固定名と一致しているか確認。

### 写真がアップロードされない

→ Worker の R2 バインディングを確認。Variable name が `PHOTOS` になっているか。

### 地図にピンが表示されない

→ `lat` `lng` カラムに緯度経度が入っているか確認。CSVインポート後の編集画面で「📍 現在地」ボタンから入力するのが楽。

---

## 拡張アイデア（将来）

- スタッフごとのアサイン機能
- 巡回ルート最適化
- 写真の位置情報（EXIF）から自動座標取得
- 撤去期限のSlack通知
- ポスター番号別の集計
- 認証（パスワードゲート / Cloudflare Access）
