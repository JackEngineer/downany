import Foundation
import Testing
@testable import TraeDownloaderCore

@Test
func parseProgressWithETA() {
    let line = "[download]  45.2% of 10.00MiB at 1.23MiB/s ETA 00:04"
    let progress = YtDlpService.parseProgressLine(line)
    #expect(progress?.percent == 45.2)
    #expect(progress?.speed == "1.23MiB/s")
    #expect(progress?.eta == "00:04")
}

@Test
func parseProgressWithoutETA() {
    let line = "[download] 100% of 10.00MiB in 00:08 at 1.23MiB/s"
    let progress = YtDlpService.parseProgressLine(line)
    #expect(progress?.percent == 100)
}

@Test
func parseProgressPercentOnly() {
    let line = "[download] 12.5%"
    let progress = YtDlpService.parseProgressLine(line)
    #expect(progress?.percent == 12.5)
}
