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

                if result.get("status") == "success":
                    st.success("🎉 疏文生成成功！")
                    st.markdown(
                        f"👉 [點此開啟產出的 Google Doc 文件]({result.get('url')})"
                    )
                else:
                    st.error(f"生成失敗: {result.get('message')}")
            except Exception as e:
                st.error(f"連線至 GAS Web App 發生錯誤: {e}")