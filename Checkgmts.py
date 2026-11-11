import json

import pytesseract
import requests
import streamlit as st
from PIL import Image

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
st.caption("請拍攝燈殼，確認辨識內容後送出；系統會比對 300 元及 500 元工作表。")

camera_image = st.camera_input("拍攝燈殼上的號碼、姓名及燈名")
scanned_text = ""
if camera_image is not None:
    try:
        image = Image.open(camera_image).convert("L")
        image.thumbnail((1800, 1800))
        scanned_text = pytesseract.image_to_string(image, lang="chi_tra+eng").strip()
        if scanned_text:
            st.info(f"**OCR 辨識結果（請核對）：**\n\n{scanned_text}")
        else:
            st.warning("未辨識到文字，請調整拍攝角度或光線後重拍。")
    except pytesseract.TesseractNotFoundError:
        st.error("伺服器找不到 Tesseract OCR，請確認 packages.txt 已安裝 OCR 套件。")
    except pytesseract.TesseractError as error:
        st.error(f"OCR 辨識失敗：{error}")
    except OSError as error:
        st.error(f"無法讀取拍攝的圖片：{error}")

if camera_image is not None:
    with st.form("verify_lamp_form"):
        st.subheader("確認或修正辨識內容")
        number1 = st.text_input("光明燈 1 號碼")
        name = st.text_input("姓名")
        light_type1 = st.text_input("光明燈 1 種類")
        number2 = st.text_input("光明燈 2 號碼（沒有請留白）")
        light_type2 = st.text_input("光明燈 2 種類（沒有請留白）")
        submitted = st.form_submit_button("🚀 送出驗證並上架")

    if submitted:
        if not number1.strip() or not name.strip() or not light_type1.strip():
            st.error("請填寫光明燈 1 號碼、姓名及光明燈 1 種類。")
        else:
            payload = {
                "action": "verify",
                "apiKey": api_key,
                "sheetIds": sheet_ids,
                "number1": number1,
                "number2": number2,
                "name": name,
                "light_type1": light_type1,
                "light_type2": light_type2,
            }
            with st.spinner("正在核對 300 元及 500 元光明燈資料..."):
                result = call_gas_api(payload)

            if result.get("status") == "success":
                speak_audio("上架成功")
                st.markdown(
                    '<div class="status-card" style="background:#d9ead3;color:#274e13">'
                    "🟢 上架成功</div>",
                    unsafe_allow_html=True,
                )
                st.success(
                    f"已記錄於「{result['sheetName']}」第 {result['rowNumber']} 列。"
                )
            elif result.get("status") == "fail":
                errors = result.get("errors", ["號碼", "姓名", "燈名"])
                error_text = "、".join(errors)
                speak_audio(f"上架失敗，不符合項目分別為{error_text}")
                st.markdown(
                    '<div class="status-card" style="background:#ffe599;color:#7f6000">'
                    "🟡 上架失敗，請修正黃燈欄位</div>",
                    unsafe_allow_html=True,
                )
                st.error(
                    f"不符合項目：**{error_text}**。"
                    "請確認輸入後重新拍攝並送出。"
                )
                if result.get("message"):
                    st.caption(result["message"])
            else:
                st.error(result.get("message", "GAS 發生未預期錯誤。"))

st.divider()
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
