"""
ROS2 Publisher
==============

Optional ROS2 integration for publishing geometry_msgs/Twist messages.
Gracefully handles missing ROS2 installation.
"""

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .twist_protocol import TwistWithLatency

logger = logging.getLogger(__name__)

# Detect ROS2 availability at import time
ROS2_AVAILABLE = False
try:
    import rclpy
    from rclpy.node import Node
    from geometry_msgs.msg import Twist
    ROS2_AVAILABLE = True
    logger.info("ROS2 available")
except ImportError:
    logger.info("ROS2 not available")


class ROS2Publisher:
    """Optional ROS2 Twist publisher.

    If ROS2 is not installed, init() returns False and publish() is a no-op.

    Args:
        topic: ROS2 topic name (e.g. '/cmd_vel').
    """

    def __init__(self, topic: str):
        self.topic = topic
        self._node = None
        self._pub = None
        self._ok = False

    def init(self) -> bool:
        """Initialize the ROS2 node and publisher.

        Returns:
            True if ROS2 is available and initialization succeeded.
        """
        if not ROS2_AVAILABLE:
            return False
        try:
            if not rclpy.ok():
                rclpy.init()
            self._node = rclpy.create_node('twist_bridge')
            self._pub = self._node.create_publisher(Twist, self.topic, 10)
            self._ok = True
            logger.info(f"ROS2 publisher: {self.topic}")
            return True
        except Exception as e:
            logger.error(f"ROS2 init failed: {e}")
            return False

    def publish(self, twist: 'TwistWithLatency'):
        """Publish a Twist message to ROS2.

        No-op if ROS2 is not initialized.
        """
        if not self._ok:
            return
        msg = Twist()
        msg.linear.x = twist.linear_x
        msg.linear.y = twist.linear_y
        msg.linear.z = twist.linear_z
        msg.angular.x = twist.angular_x
        msg.angular.y = twist.angular_y
        msg.angular.z = twist.angular_z
        self._pub.publish(msg)

    def shutdown(self):
        """Destroy the ROS2 node and shut down rclpy."""
        if self._node:
            self._node.destroy_node()
        if ROS2_AVAILABLE and rclpy.ok():
            rclpy.shutdown()