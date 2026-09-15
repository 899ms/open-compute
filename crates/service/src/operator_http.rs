//! Shared operator-owned HTTP transport with explicit proxy selection.

use open_compute_core::{OperatorProxyDecision, OperatorProxyPolicy, PlatformError};
use reqwest::{Client, Method, RequestBuilder, redirect::Policy};
use url::Url;

/// Direct and proxy clients sharing one frozen selection policy.
#[derive(Clone, Debug)]
pub(crate) struct OperatorHttpClient {
    direct: Client,
    proxied: Option<Client>,
    policy: OperatorProxyPolicy,
}

impl OperatorHttpClient {
    pub(crate) fn from_process_env() -> Result<Self, PlatformError> {
        Self::new(OperatorProxyPolicy::from_process_env()?)
    }

    pub(crate) fn new(policy: OperatorProxyPolicy) -> Result<Self, PlatformError> {
        let direct = base_builder().no_proxy().build().map_err(|_| invalid())?;
        let proxied = policy
            .proxy()
            .map(|proxy| {
                let proxy = reqwest::Proxy::all(proxy.origin()).map_err(|_| invalid())?;
                base_builder()
                    .no_proxy()
                    .proxy(proxy)
                    .build()
                    .map_err(|_| invalid())
            })
            .transpose()?;
        Ok(Self {
            direct,
            proxied,
            policy,
        })
    }

    pub(crate) fn request(
        &self,
        method: Method,
        url: Url,
    ) -> Result<RequestBuilder, PlatformError> {
        let client = match self.policy.decision(&url)? {
            OperatorProxyDecision::Direct => &self.direct,
            OperatorProxyDecision::Proxy => self.proxied.as_ref().ok_or_else(invalid)?,
        };
        Ok(client.request(method, url))
    }
}

fn base_builder() -> reqwest::ClientBuilder {
    Client::builder().redirect(Policy::none())
}

fn invalid() -> PlatformError {
    PlatformError::new(
        open_compute_core::ErrorCode::ConfigInvalid,
        "operator HTTP proxy transport could not be constructed",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

    #[tokio::test]
    async fn explicit_proxy_uses_absolute_form_and_never_falls_back() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = format!("http://{}", listener.local_addr().unwrap());
        let values = HashMap::from([("HTTPS_PROXY", proxy)]);
        let policy = OperatorProxyPolicy::from_lookup(|name| values.get(name).cloned()).unwrap();
        let client = OperatorHttpClient::new(policy).unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 4096];
            let count = stream.read(&mut request).await.unwrap();
            let request = std::str::from_utf8(&request[..count]).unwrap();
            assert!(request.starts_with("GET http://operator.invalid/probe HTTP/1.1\r\n"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok")
                .await
                .unwrap();
        });
        let response = client
            .request(
                Method::GET,
                Url::parse("http://operator.invalid/probe").unwrap(),
            )
            .unwrap()
            .send()
            .await
            .unwrap();
        assert_eq!(response.bytes().await.unwrap(), "ok");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn https_uses_connect_without_trusting_an_interception_ca() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = format!("http://{}", listener.local_addr().unwrap());
        let values = HashMap::from([("HTTPS_PROXY", proxy)]);
        let policy = OperatorProxyPolicy::from_lookup(|name| values.get(name).cloned()).unwrap();
        let client = OperatorHttpClient::new(policy).unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 4096];
            let count = stream.read(&mut request).await.unwrap();
            let request = std::str::from_utf8(&request[..count]).unwrap();
            assert!(request.starts_with("CONNECT operator.invalid:443 HTTP/1.1\r\n"));
            stream
                .write_all(b"HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n")
                .await
                .unwrap();
        });
        assert!(
            client
                .request(
                    Method::GET,
                    Url::parse("https://operator.invalid/probe").unwrap(),
                )
                .unwrap()
                .send()
                .await
                .is_err()
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn unreachable_explicit_proxy_never_falls_back_to_the_origin() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let values = HashMap::from([("HTTPS_PROXY", proxy)]);
        let policy = OperatorProxyPolicy::from_lookup(|name| values.get(name).cloned()).unwrap();
        let client = OperatorHttpClient::new(policy).unwrap();
        assert!(
            client
                .request(
                    Method::GET,
                    Url::parse("http://origin.invalid/origin-must-not-be-used").unwrap(),
                )
                .unwrap()
                .send()
                .await
                .is_err()
        );
    }
}
