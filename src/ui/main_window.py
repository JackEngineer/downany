import sys
import os
from typing import List, Union
from PyQt6.QtWidgets import (
    QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, 
    QLineEdit, QPushButton, QLabel, QProgressBar, 
    QTextEdit, QFileDialog, QMessageBox, QTabWidget,
    QGroupBox
)
from PyQt6.QtCore import Qt, QThread, pyqtSignal
from src.core.downloader import Downloader
from src.utils.logger import setup_logger

logger = setup_logger("UI")

class DownloadThread(QThread):
    """
    后台下载线程，支持单个或多个 URL 下载。
    """
    progress_signal = pyqtSignal(dict)
    finished_signal = pyqtSignal()
    error_signal = pyqtSignal(str)
    batch_progress_signal = pyqtSignal(str) # 用于发送批量下载的总体进度信息

    def __init__(self, urls: Union[str, List[str]], download_dir: str):
        super().__init__()
        if isinstance(urls, str):
            self.urls = [urls]
        else:
            self.urls = urls
        self.download_dir = download_dir
        self.downloader = Downloader(download_dir)

    def run(self):
        # 设置回调
        self.downloader.set_callbacks(
            progress=self.progress_signal.emit,
            finished=None, # 我们自己在循环中处理完成逻辑
            error=None     # 我们自己在循环中处理错误逻辑
        )
        
        total_files = len(self.urls)
        
        for index, url in enumerate(self.urls):
            try:
                msg = f"正在下载 ({index + 1}/{total_files}): {url}"
                self.batch_progress_signal.emit(msg)
                logger.info(msg)
                
                # 重置进度条
                self.progress_signal.emit({'status': 'downloading', '_percent_str': '0%'})
                
                self.downloader.download(url)
                
            except Exception as e:
                error_msg = f"下载出错 ({url}): {str(e)}"
                logger.error(error_msg)
                self.error_signal.emit(error_msg)
                # 继续下载下一个，不中断
        
        self.finished_signal.emit()

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Trae 资源下载器")
        self.resize(700, 500)
        
        # 初始化 UI
        self.init_ui()
        
        # 下载线程引用
        self.download_thread = None

    def init_ui(self):
        # 主 Widget
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        
        # 主布局
        main_layout = QVBoxLayout()
        central_widget.setLayout(main_layout)

        # 1. 选项卡控件
        self.tabs = QTabWidget()
        main_layout.addWidget(self.tabs)

        # Tab 1: 单个下载
        self.single_tab = QWidget()
        self.init_single_tab()
        self.tabs.addTab(self.single_tab, "单个下载")

        # Tab 2: 批量下载
        self.batch_tab = QWidget()
        self.init_batch_tab()
        self.tabs.addTab(self.batch_tab, "批量下载")
        
        # 2. 通用设置区 (保存目录)
        settings_group = QGroupBox("下载设置")
        settings_layout = QHBoxLayout()
        
        self.dir_input = QLineEdit()
        self.dir_input.setText(os.path.join(os.getcwd(), "downloads"))
        self.dir_btn = QPushButton("选择目录")
        self.dir_btn.clicked.connect(self.choose_directory)
        
        settings_layout.addWidget(QLabel("保存至:"))
        settings_layout.addWidget(self.dir_input)
        settings_layout.addWidget(self.dir_btn)
        settings_group.setLayout(settings_layout)
        
        main_layout.addWidget(settings_group)
        
        # 3. 状态与进度区
        status_group = QGroupBox("任务状态")
        status_layout = QVBoxLayout()
        
        self.progress_bar = QProgressBar()
        self.progress_bar.setValue(0)
        status_layout.addWidget(self.progress_bar)
        
        self.status_label = QLabel("准备就绪")
        self.status_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        status_layout.addWidget(self.status_label)
        
        status_group.setLayout(status_layout)
        main_layout.addWidget(status_group)

    def init_single_tab(self):
        layout = QVBoxLayout()
        
        # URL 输入
        input_layout = QHBoxLayout()
        self.single_url_input = QLineEdit()
        self.single_url_input.setPlaceholderText("请输入单个视频链接...")
        input_layout.addWidget(QLabel("视频链接:"))
        input_layout.addWidget(self.single_url_input)
        layout.addLayout(input_layout)
        
        layout.addStretch()
        
        # 按钮
        btn_layout = QHBoxLayout()
        self.single_download_btn = QPushButton("开始下载")
        self.single_download_btn.clicked.connect(self.start_single_download)
        self.single_download_btn.setMinimumHeight(40)
        btn_layout.addStretch()
        btn_layout.addWidget(self.single_download_btn)
        btn_layout.addStretch()
        layout.addLayout(btn_layout)
        
        layout.addStretch()
        self.single_tab.setLayout(layout)

    def init_batch_tab(self):
        layout = QVBoxLayout()
        
        layout.addWidget(QLabel("请输入视频链接 (每行一个):"))
        
        self.batch_url_input = QTextEdit()
        self.batch_url_input.setPlaceholderText("https://example.com/video1\nhttps://example.com/video2\n...")
        layout.addWidget(self.batch_url_input)
        
        # 按钮
        btn_layout = QHBoxLayout()
        self.batch_download_btn = QPushButton("开始批量下载")
        self.batch_download_btn.clicked.connect(self.start_batch_download)
        self.batch_download_btn.setMinimumHeight(40)
        btn_layout.addStretch()
        btn_layout.addWidget(self.batch_download_btn)
        btn_layout.addStretch()
        layout.addLayout(btn_layout)
        
        self.batch_tab.setLayout(layout)

    def choose_directory(self):
        dir_path = QFileDialog.getExistingDirectory(self, "选择保存目录")
        if dir_path:
            self.dir_input.setText(dir_path)

    def set_ui_enabled(self, enabled: bool):
        self.single_download_btn.setEnabled(enabled)
        self.batch_download_btn.setEnabled(enabled)
        self.single_url_input.setEnabled(enabled)
        self.batch_url_input.setEnabled(enabled)
        self.dir_input.setEnabled(enabled)
        self.dir_btn.setEnabled(enabled)

    def start_single_download(self):
        url = self.single_url_input.text().strip()
        if not url:
            QMessageBox.warning(self, "提示", "请输入有效的视频链接")
            return
        self._start_download([url])

    def start_batch_download(self):
        text = self.batch_url_input.toPlainText()
        urls = [line.strip() for line in text.split('\n') if line.strip()]
        
        if not urls:
            QMessageBox.warning(self, "提示", "请输入至少一个有效的视频链接")
            return
        self._start_download(urls)

    def _start_download(self, urls: List[str]):
        download_dir = self.dir_input.text().strip()
        if not download_dir:
            QMessageBox.warning(self, "提示", "请选择保存目录")
            return

        # 禁用 UI
        self.set_ui_enabled(False)
        self.progress_bar.setValue(0)
        
        count = len(urls)
        if count == 1:
            self.status_label.setText("正在初始化下载...")
        else:
            self.status_label.setText(f"准备下载 {count} 个文件...")
        
        # 启动后台线程
        self.download_thread = DownloadThread(urls, download_dir)
        self.download_thread.progress_signal.connect(self.update_progress)
        self.download_thread.batch_progress_signal.connect(self.update_batch_status)
        self.download_thread.finished_signal.connect(self.download_finished)
        self.download_thread.error_signal.connect(self.download_error)
        self.download_thread.start()

    def update_batch_status(self, msg):
        self.status_label.setText(msg)

    def update_progress(self, d):
        if d['status'] == 'downloading':
            # 计算百分比
            try:
                p = d.get('_percent_str', '0%').replace('%', '')
                value = float(p)
                self.progress_bar.setValue(int(value))
                
                speed = d.get('_speed_str', 'N/A')
                eta = d.get('_eta_str', 'N/A')
                
                # 获取当前文本前缀 (比如 "正在下载 (1/5): ...")
                current_text = self.status_label.text().split('|')[0].strip()
                
                self.status_label.setText(f"{current_text} | 进度: {int(value)}% | 速度: {speed} | 剩余: {eta}")
            except Exception:
                pass

    def download_finished(self):
        self.progress_bar.setValue(100)
        self.status_label.setText("所有任务已完成！")
        self.set_ui_enabled(True)
        QMessageBox.information(self, "成功", "下载任务已完成")

    def download_error(self, error_msg):
        # 这里的 error 是单个文件失败的通知
        # 在 DownloadThread 中我们已经捕获了异常并继续
        self.status_label.setText(f"警告: {error_msg}")
