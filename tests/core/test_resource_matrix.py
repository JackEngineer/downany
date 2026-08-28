"""24 production-scheduler/resource combinations, with deterministic local media."""
import threading

import pytest

from src.core.download_task import TaskStatus
from src.core.output_contract import compile_output_plan


@pytest.mark.parametrize("workers", [1, 3, 10])
@pytest.mark.parametrize("fragments", [0, 4, 16, 32])
@pytest.mark.parametrize("speed", [0, 524288])
def test_resource_matrix_bounds_real_workers_and_preserves_output_options(
    queue_download_harness, workers, fragments, speed,
):
    harness = queue_download_harness
    manager = harness.manager()
    manager.config.update_from_dict({"concurrent_downloads": workers,
                                     "concurrent_fragments": fragments, "speed_limit": speed})
    tasks = [harness.task(manager, f"task-{index}") for index in range(workers * 2 + 1)]
    manager.queue_store.upsert_tasks(tasks)
    manager.restore_tasks()
    release = threading.Event()

    def wait_for_release(*_args):
        assert release.wait(10), "test downloads were not released"

    harness.before_download = wait_for_release
    manager.start()
    try:
        harness.wait_for(lambda: sum(harness.live.values()) == workers)
        assert len(manager.active_tasks) == workers
        assert harness.peak_total == workers
        release.set()
        harness.wait_for(lambda: all(task.status == TaskStatus.COMPLETED
                                    for task in manager.get_all_tasks().values()))
    finally:
        release.set()
        manager.stop(join_timeout=5)
    assert harness.peak_total <= workers
    assert all(count == 1 for count in harness.peak_per_id.values())
    assert sum(harness.starts.values()) == len(tasks)
    assert all(count == 1 for count in harness.starts.values())
    for options in [compile_output_plan(tasks[0]).to_ydl_options(), *harness.plans]:
        if fragments:
            assert options["concurrent_fragment_downloads"] == fragments
        else:
            assert "concurrent_fragment_downloads" not in options
        if speed:
            assert options["ratelimit"] == speed
        else:
            assert "ratelimit" not in options
    stored = manager.queue_store.load_tasks()
    assert len({task.file_path for task in stored}) == len(tasks)
    assert all(task.status is TaskStatus.COMPLETED and task.progress == 100 for task in stored)
