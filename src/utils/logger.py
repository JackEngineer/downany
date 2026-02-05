import logging
import sys

def setup_logger(name: str = "Downloader") -> logging.Logger:
    """
    配置并返回一个 logger 实例。
    
    Args:
        name: Logger 的名称
        
    Returns:
        配置好的 logging.Logger 实例
    """
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)

    # 如果已经有 handler，就不再添加，防止重复日志
    if not logger.handlers:
        # 控制台处理器
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setLevel(logging.INFO)
        
        # 格式化
        formatter = logging.Formatter(
            '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        console_handler.setFormatter(formatter)
        
        logger.addHandler(console_handler)
        
    return logger
