//! Verified S3 HTTP transport using the frozen operator proxy policy.

use super::tls::der_to_pem;
use aws_smithy_http_client::proxy::ProxyConfig;
use aws_smithy_http_client::tls::rustls_provider::CryptoMode;
use aws_smithy_http_client::tls::{Provider as TlsProvider, TlsContext, TrustStore};
use aws_smithy_http_client::{Builder as HttpBuilder, Connector};
use open_compute_core::{ErrorCode, OperatorProxyDecision, OperatorProxyPolicy, PlatformError};

pub(super) fn build_verified_http_client(
    endpoint: &str,
) -> Result<aws_smithy_runtime_api::client::http::SharedHttpClient, PlatformError> {
    let mut trust = TrustStore::empty();
    for cert in webpki_root_certs::TLS_SERVER_ROOT_CERTS {
        trust = trust.with_pem_certificate(der_to_pem(cert.as_ref()));
    }
    let tls = TlsContext::builder()
        .with_trust_store(trust)
        .build()
        .unwrap_or_else(|_| {
            TlsContext::builder()
                .with_trust_store(TrustStore::empty())
                .build()
                .unwrap_or_else(|_| {
                    TlsContext::builder()
                        .build()
                        .unwrap_or_else(|_| unreachable!("tls context builder"))
                })
        });
    let policy = OperatorProxyPolicy::from_process_env()?;
    let endpoint = url::Url::parse(endpoint)
        .map_err(|_| PlatformError::new(ErrorCode::ConfigInvalid, "S3 endpoint URL is invalid"))?;
    let proxy = if policy.decision(&endpoint)? == OperatorProxyDecision::Proxy {
        let proxy = policy.proxy().ok_or_else(|| {
            PlatformError::new(
                ErrorCode::ConfigInvalid,
                "operator proxy selection is invalid",
            )
        })?;
        Some(ProxyConfig::all(proxy.origin()).map_err(|_| {
            PlatformError::new(ErrorCode::ConfigInvalid, "operator proxy URL is invalid")
        })?)
    } else {
        None
    };
    Ok(
        HttpBuilder::new().build_with_connector_fn(move |settings, components| {
            let mut builder = Connector::builder();
            if let Some(settings) = settings {
                builder = builder.connector_settings(settings.clone());
            }
            if let Some(sleep) =
                components.and_then(aws_sdk_s3::config::RuntimeComponents::sleep_impl)
            {
                builder = builder.sleep_impl(sleep);
            }
            if let Some(proxy) = proxy.clone() {
                builder = builder.proxy_config(proxy);
            }
            builder
                .tls_provider(TlsProvider::Rustls(CryptoMode::AwsLc))
                .tls_context(tls.clone())
                .build()
        }),
    )
}
