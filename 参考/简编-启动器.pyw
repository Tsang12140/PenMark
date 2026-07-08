"""
简编 - 微信图文编辑器启动器
双击此文件即可启动编辑器
"""
import os
import sys
import webbrowser
import threading
import time

# 获取脚本所在目录
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
EDITOR_HTML = os.path.join(SCRIPT_DIR, "简编.html")

def start_editor():
    """在默认浏览器中打开编辑器"""
    if not os.path.exists(EDITOR_HTML):
        print(f"找不到编辑器文件: {EDITOR_HTML}")
        input("按回车键退出...")
        return
    
    file_url = f"file:///{EDITOR_HTML.replace(os.sep, '/')}"
    webbrowser.open(file_url)
    
    # 等待一会让浏览器打开
    time.sleep(2)
    print("编辑器已启动！关闭此窗口不会影响编辑器。")
    print("提示：可以将简编.html拖到浏览器书签栏，方便快速访问。")

if __name__ == "__main__":
    start_editor()
