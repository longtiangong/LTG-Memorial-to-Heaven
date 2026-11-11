import json
import queue
import time

import pytesseract
import requests
import streamlit as st
from PIL import Image
from streamlit_webrtc import VideoProcessorBase, WebRtcMode, webrtc_streamer

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
        window.speechSynthesis.speak(utterance);
        </script>
        """,
        height=0,
    )


class LiveOCRProcessor(VideoProcessorBase):
    def __init__(self):
        self.results = queue.Queue()
        self.last_ocr_at = 0.0
        self.previous_text = ""
        self.stable_frames = 0
        self.result_sent = False

    def recv(self, frame):
        now = time.monotonic()
        if self.result_sent or now - self.last_ocr_at < 1:
            return frame
        self.last_ocr_at = now

        try:
            image = Image.fromarray(frame.to_ndarray(format="rgb24")).convert("L")
            image.thumbnail((1800, 1800))
            text = pytesseract.image_to_string(
                image,
                lang="chi_tra+eng",
                config="--psm 6",
            ).strip()
        except pytesseract.TesseractError as error:
            self.results.put(("error", f"OCR 辨識失敗：{error}"))
            self.result_sent = True
            return frame

        normalized_text = "".join(text.split())
        if len(normalized_text) < 3:
            self.previous_text = ""
            self.stable_frames = 0
            return frame
        if normalized_text == self.previous_text:
            self.stable_frames += 1
        else:
            self.previous_text = normalized_text
            self.stable_frames = 1

        if self.stable_frames >= 2:
            self.results.put(("text", text))
            self.result_sent = True
        return frame


# GAS 共用既有 Web App 與 API 金鑰，回傳明確錯誤供畫面顯示。
def call_gas_api(payload, timeout=60):
    try:
        response = requests.post(
            st.secrets["WEB_APP_URL"],
            json=payload,
            timeout=timeout,
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
st.caption("對準燈殼開始即時掃描，系統會自動比對 300 元及 500 元工作表。")

if "scan_result" not in st.session_state:
    st.session_state["scan_result"] = None
if "scan_id" not in st.session_state:
    st.session_state["scan_id"] = 0

scan_result = st.session_state["scan_result"]
if scan_result is None:
    if "scan_started_at" not in st.session_state:
        st.session_state["scan_started_at"] = time.monotonic()
    st.info("請允許瀏覽器使用相機，並將燈殼文字對準鏡頭。45 秒內未辨識成功會提示重掃。")
    scan_status = st.empty()
    scan_progress = st.progress(0)
    scan_context = webrtc_streamer(
        key=f"lamp-live-scan-{st.session_state['scan_id']}",
        mode=WebRtcMode.SENDONLY,
        video_processor_factory=LiveOCRProcessor,
        media_stream_constraints={"video": True, "audio": False},
        desired_playing_state=True,
        async_processing=True,
    )

    processor = scan_context.video_processor if scan_context.state.playing else None
    deadline = st.session_state["scan_started_at"] + 45
    while time.monotonic() < deadline:
        elapsed = 45 - max(0, deadline - time.monotonic())
        scan_progress.progress(min(int(elapsed / 45 * 100), 100))
        if processor is None and scan_context.state.playing:
            processor = scan_context.video_processor
        if processor is None:
            scan_status.info("等待相機啟動...")
            time.sleep(0.25)
            continue

        scan_status.info("正在掃描燈號、姓名及燈名...")
        try:
            event, value = processor.results.get(timeout=0.25)
        except queue.Empty:
            continue

        if event == "error":
            st.session_state["scan_result"] = {
                "status": "error",
                "message": value,
            }
            break

        scan_status.info("掃描成功，確認中...")
        speak_audio("掃描成功，確認中")
        result = call_gas_api(
            {
                "action": "scan_verify",
                "apiKey": api_key,
                "sheetIds": sheet_ids,
                "scannedText": value,
            },
            timeout=15,
        )
        st.session_state["scan_result"] = result
        if result.get("status") == "success":
            speak_audio(
                f"上架成功，{result['sheetName']}，"
                f"第{result['lampIndex']}組，號碼"
                f"{result['number']}，燈名{result['lightType']}"
            )
        elif result.get("status") == "error":
            speak_audio("連線核對失敗，請重新掃描")
        else:
            errors = "、".join(result.get("errors", ["資料"]))
            speak_audio(f"上架失敗，不符合項目為{errors}，掃描失敗，再重掃")
        break

    if st.session_state["scan_result"] is None:
        st.session_state["scan_result"] = {
            "status": "timeout",
            "message": "45 秒內未能辨識燈殼文字，請重新掃描。",
        }
        speak_audio("掃描失敗，再重掃")
    st.rerun()
else:
    st.session_state.pop("scan_started_at", None)
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
    elif scan_result.get("status") == "timeout":
        st.warning(scan_result["message"])
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

    if st.button("🔄 重新掃描", key="restart_live_scan"):
        st.session_state["scan_result"] = None
        st.session_state["scan_id"] += 1
        st.session_state["scan_started_at"] = time.monotonic()
        st.rerun()

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
