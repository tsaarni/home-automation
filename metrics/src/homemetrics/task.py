from __future__ import annotations

import logging
from typing import Protocol, Type

logger = logging.getLogger("task")


# Interface for task classes.
class Task(Protocol):
    def configure(self, instance_name: str, config: dict) -> None:
        ...

    async def start(self) -> None:
        ...


class TaskException(Exception):
    pass


# Global registry of task classes.
task_classes: dict[str, Type[Task]] = {}


def register(cls: Type[Task], task_type: str) -> None:
    logger.debug("Registering task class: %s", task_type)
    task_classes[task_type] = cls


def get_task_class(task_type: str) -> Type[Task]:
    if task_type not in task_classes:
        raise KeyError(f"Unknown task type: {task_type}")
    return task_classes[task_type]
