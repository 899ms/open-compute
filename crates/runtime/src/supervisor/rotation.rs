use super::*;

impl Actor {
    pub(super) async fn rotate_generation(&mut self) -> Result<(), PlatformError> {
        if self.snap.state != SupervisorState::Running || self.shutting_down {
            return Err(runtime_rotation_failed());
        }
        match self.teardown_child().await {
            Ok(_) => {
                self.budget = RestartBudget::new();
                self.consecutive_failures = 0;
                self.begin_attempt();
                Ok(())
            }
            Err(_) => {
                self.fail_closed_after_teardown();
                Err(runtime_rotation_failed())
            }
        }
    }
}
