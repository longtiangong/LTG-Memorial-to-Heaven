import requests
import streamlit as st

st.set_page_config(page_title="光明燈疏文生成系統", layout="wide")

st.title("🪔 光明燈 A3 疏文生成系統")

# 讀取 Secrets
lamp_type = st.selectbox(
    "光明燈金額",
    ["500", "300"],
    format_func=lambda value: f"{value}元光明燈",
)
sheet_id = st.secrets.get(f"SHEET_{lamp_type}_ID", "")
web_app_url = st.secrets.get("WEB_APP_URL", "")
gas_api_key = st.secrets.get("GAS_API_KEY", "")

doc_title = st.text_input("輸出的 Word 檔名", value=f"{lamp_type}元光明燈疏文")

if st.button(f"🚀 開始產出 {lamp_type}元光明燈 A3 疏文文件"):
    if not sheet_id:
        st.error(f"請確認 Secrets 中已設定 SHEET_{lamp_type}_ID")
    elif not web_app_url or not gas_api_key:
        st.error("請確認 Secrets 中已設定 WEB_APP_URL 與 GAS_API_KEY")
    else:
        with st.spinner("正在處理資料並製作 A3 排版文件..."):
            payload = {
                "apiKey": gas_api_key,
                "lampType": lamp_type,
                "sheetId": sheet_id,
                "docTitle": doc_title,
            }

            try:
                response = requests.post(web_app_url, json=payload, timeout=60)
                result = response.json()

                if result.get("status") == "success" and result.get("wordDownloadUrl"):
                    st.success("🎉 Word 文件產出成功！")
                    # * 11092304 Word 文字270 度旋轉，A3直向
                    st.markdown(
                        f"👉 [下載 A3 直式 Word 檔]({result['wordDownloadUrl']})"
                    )
                    # * 11092332 預設字體16 pt，資料欄相鄰間距 3 pt
                    # * 11100911 修正號碼文字顯示為橫向
                    st.caption(
                        "Word 檔為單欄排版，文字已旋轉 270°，不顯示工作表欄位名稱；"
                        "光明燈號碼會隨直式欄位旋轉 270° 顯示，每筆資料列間距約 5 pt。"
                        "字體預設 16 pt，同址資料放不下時自動縮小至最小 8 pt；"
                        "資料量過大時會接續到下一頁，不會省略資料。"
                    )
                elif result.get("status") == "success":
                    st.error(
                        "GAS 未回傳 Word 檔連結，"
                        "請更新並重新部署 GAS 後再試。"
                    )
                else:
                    message = result.get("message", "未知錯誤")
                    if "DriveApp" in message or "auth/drive" in message:
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