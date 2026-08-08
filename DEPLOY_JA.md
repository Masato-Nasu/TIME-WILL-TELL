# TIME WILL TELL v0.1.7 — Windows / Cloudflare 導入手順

このリポジトリにはSecretの実値を含めません。APIキー、OAuth Client Secret、暗号鍵はGitHubへコミットせず、Cloudflare Worker Secretsへ登録してください。

## 1. インストール

PowerShell:

```powershell
npm install
```

## 2. Cloudflareへログイン

```powershell
npx wrangler@latest login
```

## 3. D1を作成

```powershell
npx wrangler@latest d1 create time-will-tell-db --location=apac
```

表示された `database_id` を `wrangler.jsonc` の `REPLACE_WITH_D1_DATABASE_ID` と置き換えます。

## 4. R2を作成

```powershell
npx wrangler@latest r2 bucket create time-will-tell-attachments
```

R2は添付ファイル用です。公開バケットにはしません。

## 5. D1 migration

```powershell
npx wrangler@latest d1 migrations apply time-will-tell-db --remote
```

## 6. 基本Secret

```powershell
npx wrangler@latest secret put CONTENT_SECRET
npx wrangler@latest secret put RATE_SALT
```

`CONTENT_SECRET` は24文字以上の十分長いランダム文字列を使用してください。紛失すると保存済みの暗号化データを復号できません。

## 7. Gmail API

Google CloudでGmail APIを有効化し、OAuth同意画面を設定します。

OAuthクライアントはWebアプリケーションとして作成し、リダイレクトURIに次を登録します。

```text
https://あなたのWorker URL/gmail/callback
```

Gmailのスコープは次を使用します。

```text
https://www.googleapis.com/auth/gmail.send
```

Worker Secretsへ登録:

```powershell
npx wrangler@latest secret put GMAIL_CLIENT_ID
npx wrangler@latest secret put GMAIL_CLIENT_SECRET
```

`wrangler.jsonc` の `GMAIL_SENDER_ACCOUNT` を専用送信アカウントに設定します。

デプロイ後、次をブラウザで開いて専用Gmailを接続します。

```text
https://あなたのWorker URL/gmail/connect
```

OAuth refresh tokenは暗号化してD1へ保存されます。

## 8. LINE（利用する場合）

LINE側で以下を作成します。

- LINE公式アカウント + Messaging API
- 同じProvider内のLINE Loginチャネル
- LINE LoginチャネルとLINE公式アカウントをリンク

LINE LoginのCallback URL:

```text
https://あなたのWorker URL/line/callback
```

Worker Secretsへ登録:

```powershell
npx wrangler@latest secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler@latest secret put LINE_LOGIN_CHANNEL_ID
npx wrangler@latest secret put LINE_LOGIN_CHANNEL_SECRET
```

## 9. APP_BASE_URL

`wrangler.jsonc` の

```text
https://REPLACE_WITH_YOUR_DOMAIN
```

を本番Worker URLへ変更します。

## 10. デプロイ

```powershell
npx wrangler@latest deploy
```

## 11. 動作確認

### DATE

1. FROMとMESSAGEを入力
2. Gmail / LINE受取人を追加
3. 数分後の日時を指定
4. `SEAL`
5. 指定時刻後に受取人へ届くことを確認
6. 開いたメッセージに `SEALED — YYYY.MM.DD` が表示されることを確認

### WHEN

1. 条件を入力
2. `SEAL`
3. 表示されたTRIGGER LINKを開く
4. `TRIGGER`
5. 受取人へ届くことを確認

## セキュリティ上の注意

- `.dev.vars` はコミットしないでください。
- OAuth Client SecretやWorker SecretをREADME、Issue、コミットに貼らないでください。
- Gmailは専用送信アカウントを推奨します。
- `gmail.send` 以外のGmail読み取り権限は不要です。
