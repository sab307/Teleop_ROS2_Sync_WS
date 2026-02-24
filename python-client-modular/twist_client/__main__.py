"""
Entry point for `python -m twist_client`.

Usage:
    python -m twist_client [--url ws://localhost:8080/ws/data] [--topic /cmd_vel]
"""

import asyncio
import argparse
import logging
import signal
import sys

from .client import TwistClient

logger = logging.getLogger("TwistClient")


def parse_args():
    parser = argparse.ArgumentParser(description="Twist Client - Binary Protocol")
    parser.add_argument("--url", "-u", default="ws://localhost:8080/ws/data")
    parser.add_argument("--topic", "-t", default=None, help="ROS2 topic")
    parser.add_argument("--verbose", "-v", action="store_true")
    return parser.parse_args()


async def run():
    args = parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )

    print(f"URL:   {args.url}")
    print(f"Topic: {args.topic or 'disabled'}\n")

    client = TwistClient(url=args.url, ros2_topic=args.topic)

    shutdown = asyncio.Event()
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, shutdown.set)

    try:
        if await client.connect():
            print("Connected. Waiting for commands...\n")

            async def stats_printer():
                while not shutdown.is_set():
                    await asyncio.sleep(5.0)
                    logger.info(f"Stats: {client.stats}")

            task = asyncio.create_task(stats_printer())
            await shutdown.wait()
            task.cancel()
        else:
            print("Connection failed")
            return 1
    finally:
        await client.close()

    return 0


def main():
    try:
        sys.exit(asyncio.run(run()))
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()