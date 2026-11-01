# Two-axis robot arm

`arm.urdf` is the native source. It uses metres, kilograms, seconds and radians with Z up, independent of the project's CAD millimetres. The shoulder is revolute (−1.2 to +1.2 rad); extension is prismatic (0 to 0.16 m). Link masses and inertia describe an ideal demonstration, not measured hardware.

The Robotics view loads native visuals through URDFLoader and simulates real Rapier rigid bodies, gravity, contacts and joint constraints. Fix the base for normal arm use; release it to observe gravity and ground contact. Position targets clamp to URDF joint limits. Reset reconstructs the initial physical world.

There is no robot device connection. The simulated positions are neither commanded hardware state nor measured state.
