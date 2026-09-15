use super::*;

impl<F, Fut> RuntimeValidator for F
where
    F: Fn(ValidationCandidate) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<(), PlatformError>> + Send + 'static,
{
    fn validate(
        &self,
        candidate: ValidationCandidate,
    ) -> Pin<Box<dyn Future<Output = Result<(), PlatformError>> + Send + '_>> {
        Box::pin((self)(candidate))
    }

    fn validate_deployment(
        &self,
        candidate: ValidationCandidate,
    ) -> Pin<Box<dyn Future<Output = Result<StartupId, PlatformError>> + Send + '_>> {
        Box::pin(async move {
            self.validate(candidate).await?;
            Ok(test_startup_id())
        })
    }

    fn current_generation(&self) -> Option<StartupId> {
        Some(test_startup_id())
    }
}

fn test_startup_id() -> StartupId {
    "018f47a2-3b4c-7def-8abc-0123456789ab"
        .parse()
        .expect("fixed test startup id")
}
