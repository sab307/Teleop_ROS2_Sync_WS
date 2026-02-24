#!/usr/bin/env python3
"""

Usage:
    python main.py [--url ws://localhost:8080/ws/data] [--topic /cmd_vel]

Or 
    python -m twist_client [--url ws://localhost:8080/ws/data] [--topic /cmd_vel]
"""

from twist_client.__main__ import main

if __name__ == "__main__":
    main()