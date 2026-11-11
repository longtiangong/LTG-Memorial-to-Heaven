import hashlib
import json

import pytesseract
import requests
import streamlit as st
from PIL import Image

# 頁面以手機直向操作為主，使用置中版面與大尺寸表單控制項。
st.set_page_config(
    page_title="光明燈上架確認系統",
    page_icon="🏮",
    layout="centered",
)

st.markdown(
    """
    <style>
    .stButton > button {
        min-height: 3.25rem;
        width: 100%;
        font-size: 1.2rem;
        border-radius: 0.75rem;
    }
    .stTextInput input, .stSelectbox, .stRadio {
        font-size: 1.1rem;
    }
    h1, h2, h3 { text-align: center; }
    .status-card {
        padding: 1rem;
        border-radius: 0.75rem;
        font-size: 1.25rem;
        font-weight: bold;
        text-align: center;
        margin-bottom: 1rem;
    }
    </style>
    """,
    unsafe_allow_html=True,
)


# 使用瀏覽器語音合成回報上架及增修查詢結果。
def speak_audio(text):
    safe_text = json.dumps(text, ensure_ascii=False).replace("<", "\\u003c")
    st.components.v1.html(
        f"""
        <script>
        const utterance = new SpeechSynthesisUtterance({safe_text});
        utterance.lang = "zh-TW";
        utterance.rate = 1;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
        </script>
        """,
        height=0,
    )


# GAS 共用既有 Web App 與 API 金鑰，回傳明確錯誤供畫面顯示。
def call_gas_api(payload):
    try:
        response = requests.post(
            st.secrets["WEB_APP_URL"],
            json=payload,
            timeout=60,
        )
        response.raise_for_status()
        result = response.json()
    except requests.RequestException as error:
        return {"status": "error", "message": f"連線 GAS 失敗：{error}"}
    except ValueError:
        return {"status": "error", "message": "GAS 回傳內容不是有效的 JSON。"}

    if not isinstance(result, dict):
        return {"status": "error", "message": "GAS 回傳格式不正確。"}
    return result


# 保留太歲分類選項；太歲工作表 ID 尚未提供，目前只開放光明燈。
st.sidebar.title("🏮 燈品分類管理")
category = st.sidebar.radio("選擇燈種類別", ["光明燈", "太歲"])

if category == "太歲":
    st.title("🏮 太歲上架確認")
    st.info("目前先完成光明燈；太歲工作表建立後再開放此功能。")
    st.stop()

required_secrets = (
    "SHEET_300_ID",
    "SHEET_500_ID",
    "WEB_APP_URL",
    "GAS_API_KEY",
)
missing_secrets = [key for key in required_secrets if not st.secrets.get(key)]
if missing_secrets:
    st.error(f"請在 Streamlit Secrets 設定：{', '.join(missing_secrets)}")
    st.stop()
if not st.secrets["WEB_APP_URL"].strip().endswith("/exec"):
    st.error("WEB_APP_URL 必須是 Apps Script Web App 的 /exec 網址。")
    st.stop()

sheet_ids = {
    "300": st.secrets["SHEET_300_ID"],
    "500": st.secrets["SHEET_500_ID"],
}
api_key = st.secrets["GAS_API_KEY"]

st.title("🏮 光明燈上架確認")
st.caption("拍攝燈殼後，系統會自動比對 300 元及 500 元工作表並記錄上架結果。")

# * 11111615 拍照後，系統直接拿 OCR 文字比對與 300／500 元工作表
camera_image = st.camera_input("拍攝燈殼上的號碼、姓名及燈名")
if camera_image is None:
    st.session_state["scan_image_digest"] = None
    st.session_state["scan_result"] = {}
else:
    try:
        # 灰階及縮圖降低 OCR 處理負擔。
        image = Image.open(camera_image).convert("L")
        image.thumbnail((1800, 1800))
        image_digest = hashlib.sha256(camera_image.getvalue()).hexdigest()
        is_new_image = st.session_state.get("scan_image_digest") != image_digest
        if is_new_image:
            st.session_state["scan_image_digest"] = image_digest
            st.session_state["scan_result"] = {}

        scanned_text = pytesseract.image_to_string(
            image,
            lang="chi_tra+eng",
            config="--psm 6",
        ).strip()
        if scanned_text:
            st.info(f"**OCR 掃描文字：**\n\n{scanned_text}")
            if is_new_image:
                with st.spinner("正在自動核對掃描文字與兩份工作表..."):
                    result = call_gas_api(
                        {
                            "action": "scan_verify",
                            "apiKey": api_key,
                            "sheetIds": sheet_ids,
                            "scannedText": scanned_text,
                        }
                    )
                st.session_state["scan_result"] = result
                if result.get("status") == "success":
                    speak_audio(
                        f"上架成功，{result['sheetName']}，"
                        f"第{result['lampIndex']}組，號碼"
                        f"{result['number']}，燈名{result['lightType']}"
                    )
                elif result.get("status") == "fail":
                    errors = "、".join(result.get("errors", ["資料"]))
                    speak_audio(f"上架失敗，不符合項目為{errors}，請重新掃描")
                elif result.get("status") == "ambiguous":
                    speak_audio("找到多筆相同姓名，無法判定，請重新掃描")
                elif result.get("status") == "not_found":
                    speak_audio("掃描文字未找到相符姓名或資料，請重新掃描")
        else:
            st.warning("未辨識到文字，請調整拍攝角度或光線後重新掃描。")
            if is_new_image:
                st.session_state["scan_result"] = {
                    "status": "not_found",
                    "message": "沒有辨識到文字，請重新拍攝。",
                }
                speak_audio("未辨識到文字，請重新拍攝")
    except pytesseract.TesseractNotFoundError:
        st.error("伺服器找不到 Tesseract OCR，請確認 packages.txt 已安裝 OCR 套件。")
    except pytesseract.TesseractError as error:
        st.error(f"OCR 辨識失敗：{error}")
    except OSError as error:
        st.error(f"無法讀取拍攝的圖片：{error}")

if camera_image is not None and st.session_state.get("scan_image_digest"):
    scan_result = st.session_state.get("scan_result", {})
    if scan_result.get("status") == "success":
        st.markdown(
            '<div class="status-card" style="background:#d9ead3;color:#274e13">'
            "🟢 上架成功</div>",
            unsafe_allow_html=True,
        )
        st.success(
            f"符合「{scan_result['sheetName']}」："
            f"第 {scan_result['lampIndex']} 組，號碼 "
            f"{scan_result['number']}，燈名「{scan_result['lightType']}」；"
            f"已在第 {scan_result['rowNumber']} 列記錄綠燈。"
        )
    elif scan_result.get("status") in ("fail", "not_found", "ambiguous"):
        errors = scan_result.get("errors", [])
        if errors:
            st.markdown(
                '<div class="status-card" style="background:#ffe599;color:#7f6000">'
                "🟡 上架失敗，請重新掃描</div>",
                unsafe_allow_html=True,
            )
            st.error(f"不符合項目：**{'、'.join(errors)}**。")
        else:
            st.warning(scan_result.get("message", "無法判定，請重新掃描。"))
        if scan_result.get("sheetName"):
            st.caption(
                f"已在「{scan_result['sheetName']}」第 "
                f"{scan_result['rowNumber']} 列標示不符合欄位。"
            )
    elif scan_result.get("status") == "error":
        st.error(scan_result.get("message", "無法查詢工作表，請檢查 GAS 設定。"))

st.divider()
# 比對成功時保存的資料快照；新增或異動欄位會以紅燈提示重新掃描。
if st.button("🔍 查詢增修資料"):
    payload = {
        "action": "check_updates",
        "apiKey": api_key,
        "sheetIds": sheet_ids,
    }
    with st.spinner("正在檢查兩份光明燈工作表..."):
        result = call_gas_api(payload)

    if result.get("status") != "success":
        st.error(result.get("message", "查詢增修資料失敗。"))
    elif result.get("has_updates"):
        speak_audio("未上架")
        st.markdown(
            '<div class="status-card" style="background:#f4cccc;color:#990000">'
            "🔴 發現新增或修改資料</div>",
            unsafe_allow_html=True,
        )
        for sheet_result in result.get("sheets", []):
            st.write(
                f"**{sheet_result['sheetName']}**："
                f"{sheet_result['changedRows']} 筆待重新核對"
            )
        st.warning("請逐筆拍攝並完成驗證；通過後該列燈號會更新為綠燈。")
    else:
        speak_audio("目前資料皆已上架")
        st.success("目前兩份工作表都沒有待確認的新增或修改資料。")
