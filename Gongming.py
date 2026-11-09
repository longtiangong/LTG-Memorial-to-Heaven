import requests
import streamlit as st

st.set_page_config(page_title="光明燈疏文生成系統", layout="wide")

st.title("🪔 500元光明燈 A3 疏文生成系統")

# 讀取 Secrets
sheet_id = st.secrets.get("SHEET_500_ID", "")
web_app_url = st.secrets.get("WEB_APP_URL", "")
gas_api_key = st.secrets.get("GAS_API_KEY", "")

doc_title = st.text_input("輸出的 Google Docs 檔名", value="500元光明燈疏文")

if st.button("🚀 開始產出 A3 疏文文件"):
    if not web_app_url or not gas_api_key:
        st.error("請確認 Secrets 中已設定 WEB_APP_URL 與 GAS_API_KEY")
    else:
        with st.spinner("正在處理資料並製作 A3 排版文件..."):
            payload = {
                "apiKey": gas_api_key,
                "sheetId": sheet_id,
                "docTitle": doc_title,
            }

            try:
                response = requests.post(web_app_url, json=payload, timeout=60)
                result = response.json()

                if (
                    result.get("status") == "success"
                    and result.get("url")
                    and result.get("wordDownloadUrl")
                ):
                    st.success("🎉 Google 文件與 Word 文件產出成功！")
                    st.markdown(
                        f"👉 [點此開啟產出的 Google Doc 文件]({result.get('url')})"
                    )
                    st.markdown(
                        f"👉 [下載 A3 直式橫書 Word 檔]({result['wordDownloadUrl']})"
                    )
                elif result.get("status") == "success":
                    st.error(
                        "GAS 未回傳 Google 文件或 Word 檔連結，"
                        "請更新並重新部署 GAS 後再試。"
                    )
                    if result.get("url"):
                        st.markdown(
                            f"👉 [開啟已產出的 Google Doc 文件]({result['url']})"
                        )
                else:
                    message = result.get("message", "未知錯誤")
                    if "Converting from application/vnd.google-apps.document" in message:
                        st.error(
                            "目前線上的 GAS 仍在執行舊版 Word 轉檔程式。"
                            "請將最新 GAS.gs 同步至 Apps Script，建立新部署版本，"
                            "並確認 Streamlit 使用新部署網址。"
                        )
                        st.caption(f"Google 回傳訊息：{message}")
                    elif "DriveApp" in message or "auth/drive" in message:
                        st.error(
                            "GAS 尚未取得 Google Drive 授權。請在 Apps Script "
                            "編輯器執行 authorizeDriveAccess() 並完成授權，"
                            "再建立新部署版本。"
                        )
                        st.caption(f"Google 回傳訊息：{message}")
                    elif (
                        "SpreadsheetApp.openById" in message
                        or "auth/spreadsheets" in message
                    ):
                        st.error(
                            "GAS 尚未取得試算表授權。請確認 appsscript.json "
                            "含有 spreadsheets 權限，在 Apps Script 編輯器"
                            "以實際試算表 ID 執行一次授權，再建立新部署版本。"
                        )
                        st.caption(f"Google 回傳訊息：{message}")
                    else:
                        st.error(f"生成失敗: {message}")
            except Exception as e:
                st.error(f"連線至 GAS Web App 發生錯誤: {e}")