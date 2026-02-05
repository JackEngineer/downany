import sys
import os
from PyQt6.QtWidgets import (
    QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, 
    QLineEdit, QPushButton, QLabel, QProgressBar, 
    QTextEdit, QFileDialog, QMessageBox
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal
from src.core.downloader import Downloader
from src.utils.logger import setup_logger

logger = setup_logger("UI")

class DownloadThread(QThread):
    """
    后台下载线程，避免阻塞主界面。
    """
    progress_signal = pyqtSignal(dict)
    finished_signal = pyqtSignal()
    error_signal = pyqtSignal(str)
    log_signal = pyqtSignal(str)

    def __init__(self, url: str, download_dir: str):
        super().__init__()
        self.url = url
        self.download_dir = download_dir
        self.downloader = Downloader(download_dir)

    def run(self):
        # 设置回调
        self.downloader.set_callbacks(
            progress=self.progress_signal.emit,
            finished=self.finished_signal.emit,
            error=self.error_signal.emit
        )
        
        try:
            self.downloader.download(self.url)
        except Exception as e:
            self.error_signal.emit(str(e))

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Trae 资源下载器")
        self.resize(600, 400)
        
        # 初始化 UI
        self.init_ui()
        
        # 下载线程引用
        self.download_thread = None

    def init_ui(self):
        # 主 Widget
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        
        # 主布局
        layout = QVBoxLayout()
        central_widget.setLayout(layout)
        
        # 1. URL 输入区
        url_layout = QHBoxLayout()
        self.url_input = QLineEdit()
        self.url_input.setPlaceholderText("请输入视频链接...")
        url_layout.addWidget(QLabel("链接:"))
        url_layout.addWidget(self.url_input)
        layout.addLayout(url_layout)
        
        # 2. 目录选择区
        dir_layout = QHBoxLayout()
        self.dir_input = QLineEdit()
        self.dir_input.setText(os.path.join(os.getcwd(), "downloads"))
        self.dir_btn = QPushButton("选择目录")
        self.dir_btn.clicked.connect(self.choose_directory)
        dir_layout.addWidget(QLabel("保存至:"))
        dir_layout.addWidget(self.dir_input)
        dir_layout.addWidget(self.dir_btn)
        layout.addLayout(dir_layout)
        
        # 3. 操作按钮
        btn_layout = QHBoxLayout()
        self.download_btn = QPushButton("开始下载")
        self.download_btn.clicked.connect(self.start_download)
        btn_layout.addStretch()
        btn_layout.addWidget(self.download_btn)
        btn_layout.addStretch()
        layout.addLayout(btn_layout)
        
        # 4. 进度条
        self.progress_bar = QProgressBar()
        self.progress_bar.setValue(0)
        layout.addWidget(self.progress_bar)
        
        # 5. 状态标签
        self.status_label = QLabel("准备就绪")
        self.status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(self.status_label)
        
        # 6. 日志输出 (可选)
        # self.log_output = QTextEdit()
        # self.log_output.setReadOnly(True)
        # layout.addWidget(self.log_output)

    def choose_directory(self):
        dir_path = QFileDialog.getExistingDirectory(self, "选择保存目录")
        if dir_path:
            self.dir_input.setText(dir_path)

    def start_download(self):
        url = self.url_input.text().strip()
        if not url:
            QMessageBox.warning(self, "提示", "请输入有效的视频链接")
            return
            
        download_dir = self.dir_input.text().strip()
        if not download_dir:
            QMessageBox.warning(self, "提示", "请选择保存目录")
            return

        # 禁用按钮防止重复点击
        self.download_btn.setEnabled(False)
        self.url_input.setEnabled(False)
        self.progress_bar.setValue(0)
        self.status_label.setText("正在解析...")
        
        # 启动后台线程
        self.download_thread = DownloadThread(url, download_dir)
        self.download_thread.progress_signal.connect(self.update_progress)
        self.download_thread.finished_signal.connect(self.download_finished)
        self.download_thread.error_signal.connect(self.download_error)
        self.download_thread.start()

    def update_progress(self, d):
        if d['status'] == 'downloading':
            # 计算百分比
            try:
                p = d.get('_percent_str', '0%').replace('%', '')
                value = float(p)
                self.progress_bar.setValue(int(value))
                
                speed = d.get('_speed_str', 'N/A')
                eta = d.get('_eta_str', 'N/A')
                self.status_label.setText(f"下载中... 速度: {speed} | 剩余时间: {eta}")
            except Exception:
                pass

    def download_finished(self):
        self.progress_bar.setValue(100)
        self.status_label.setText("下载完成！")
        self.download_btn.setEnabled(True)
        self.url_input.setEnabled(True)
        QMessageBox.information(self, "成功", "视频下载已完成")

    def download_error(self, error_msg):
        self.status_label.setText("下载失败")
        self.download_btn.setEnabled(True)
        self.url_input.setEnabled(True)
        QMessageBox.critical(self, "错误", f"下载过程中发生错误:\n{error_msg}")
