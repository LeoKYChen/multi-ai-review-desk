# Multi-AI 雙 AI 協作工作臺

> 私人使用｜開發中｜目標日期：2026-11-01｜**尚未部署**

你只需交辦一次，**ChatGPT／OpenAI API** 與 **Gemini API** 即可各自分析、互相交換意見，再各自提出修正建議；**只有你能決定採納、退回或結案**。

**目前版本為 v0.3.0 開發原型**，完成前後端程式與本機自動測試，尚未部署 Cloudflare D1/Workers，也尚未取得或驗證真實模型 API 憑證。

## 架構
- Cloudflare Workers：網頁、任務控制、模型 API 呼叫。
- Cloudflare D1：交辦指令、從 Word 擷取的文字、AI 初稿、交叉意見、個別建議及人工決定。
- 無 R2、無 Google Drive、無 Word 原始檔永久儲存。
- 單一人類審查者，沒有第三個 AI 總審查官。
- 不與觀護人學習平臺整合，也不開發特定題庫、法律研究或文件專用功能。

目前介面提供 Word .docx 上傳（最多 3MB）、登入、任務清單、兩欄 AI 意見、人工最後決定。沒有模型憑證時，不會輸出虛構 AI 回覆。

## 驗證
參閱 [Cloudflare 後端說明](cloudflare/README.md)。

## 上線前仍需完成
實際 Cloudflare Worker/D1 部署與端對端驗收；模型 API 憑證及個人預算確認；登入限速及私有存取防護；D1 備份與復原測試。**不要將 API Key 或工作臺登入密碼提交到 GitHub。**

程式參考開源專案 [Feedback Desk](https://github.com/aixwangtw/feedback-desk) 的任務協作概念，但目前不是完整 fork。
