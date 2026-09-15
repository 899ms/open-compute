//! Frozen proxy selection for operator-owned outbound HTTP.

use crate::{ErrorCode, PlatformError};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::OnceLock;
use url::Url;

const PROXY_VARIABLES: [&str; 6] = [
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
];

/// One validated operator HTTP proxy origin.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OperatorProxy {
    origin: String,
    source_variable: &'static str,
}

impl OperatorProxy {
    /// Credential-free canonical `http://host:port` origin.
    #[must_use]
    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// Environment variable that selected this proxy.
    #[must_use]
    pub const fn source_variable(&self) -> &'static str {
        self.source_variable
    }
}

/// Direct or proxy transport decision for one destination.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperatorProxyDecision {
    /// Connect to the destination directly.
    Direct,
    /// Connect through the selected operator proxy.
    Proxy,
}

/// Validated, immutable operator proxy and `NO_PROXY` policy.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct OperatorProxyPolicy {
    proxy: Option<OperatorProxy>,
    no_proxy: Vec<NoProxyRule>,
}

impl OperatorProxyPolicy {
    /// Parse and freeze the current process environment on first use.
    pub fn from_process_env() -> Result<Self, PlatformError> {
        static POLICY: OnceLock<Result<OperatorProxyPolicy, ()>> = OnceLock::new();
        POLICY
            .get_or_init(|| Self::from_lookup(|name| std::env::var(name).ok()).map_err(|_| ()))
            .clone()
            .map_err(|()| invalid())
    }

    /// Parse a supplied environment lookup. Useful for deterministic startup tests.
    pub fn from_lookup(
        mut lookup: impl FnMut(&str) -> Option<String>,
    ) -> Result<Self, PlatformError> {
        let proxy = PROXY_VARIABLES.into_iter().find_map(|name| {
            lookup(name)
                .filter(|value| !value.trim().is_empty())
                .map(|value| (name, value))
        });
        let no_proxy = lookup("NO_PROXY")
            .filter(|value| !value.trim().is_empty())
            .or_else(|| lookup("no_proxy").filter(|value| !value.trim().is_empty()))
            .unwrap_or_default()
            .split(',')
            .filter_map(NoProxyRule::parse)
            .collect();
        Ok(Self {
            proxy: proxy
                .map(|(name, value)| parse_proxy(name, &value))
                .transpose()?,
            no_proxy,
        })
    }

    /// Selected proxy, if any.
    #[must_use]
    pub fn proxy(&self) -> Option<&OperatorProxy> {
        self.proxy.as_ref()
    }

    /// Select direct or proxy transport for one already-validated HTTP URL.
    pub fn decision(&self, destination: &Url) -> Result<OperatorProxyDecision, PlatformError> {
        if !matches!(destination.scheme(), "http" | "https") {
            return Err(invalid());
        }
        let host = destination.host_str().ok_or_else(invalid)?;
        if destination
            .host()
            .and_then(|host| match host {
                url::Host::Ipv4(value) => Some(IpAddr::V4(value)),
                url::Host::Ipv6(value) => Some(IpAddr::V6(value)),
                url::Host::Domain(_) => None,
            })
            .is_some_and(|address| address.is_loopback())
            || host.eq_ignore_ascii_case("localhost")
            || self.no_proxy.iter().any(|rule| rule.matches(host))
            || self.proxy.is_none()
        {
            Ok(OperatorProxyDecision::Direct)
        } else {
            Ok(OperatorProxyDecision::Proxy)
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum NoProxyRule {
    All,
    Domain(String),
    Ip(IpAddr),
    Cidr(IpAddr, u8),
}

impl NoProxyRule {
    fn parse(value: &str) -> Option<Self> {
        let value = value.trim();
        if value == "*" {
            return Some(Self::All);
        }
        if let Some((address, prefix)) = value.split_once('/') {
            let address = address.parse().ok()?;
            let prefix = prefix.parse().ok()?;
            if prefix <= address_bits(address) {
                return Some(Self::Cidr(address, prefix));
            }
            return None;
        }
        if let Ok(address) = value.trim_matches(['[', ']']).parse() {
            return Some(Self::Ip(address));
        }
        let domain = value.trim_start_matches('.').to_ascii_lowercase();
        (!domain.is_empty()
            && domain
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-')))
        .then_some(Self::Domain(domain))
    }

    fn matches(&self, host: &str) -> bool {
        match self {
            Self::All => true,
            Self::Domain(domain) => {
                let host = host.to_ascii_lowercase();
                host == *domain
                    || host
                        .strip_suffix(domain)
                        .is_some_and(|prefix| prefix.ends_with('.'))
            }
            Self::Ip(expected) => host
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|value| value == *expected),
            Self::Cidr(network, prefix) => host
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|address| in_cidr(address, *network, *prefix)),
        }
    }
}

fn parse_proxy(source_variable: &'static str, value: &str) -> Result<OperatorProxy, PlatformError> {
    let url = Url::parse(value).map_err(|_| invalid())?;
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
        || url.port().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    Ok(OperatorProxy {
        origin: format!(
            "http://{}:{}",
            match url.host().ok_or_else(invalid)? {
                url::Host::Ipv6(value) => format!("[{value}]"),
                host => host.to_string(),
            },
            url.port().ok_or_else(invalid)?
        ),
        source_variable,
    })
}

const fn address_bits(address: IpAddr) -> u8 {
    match address {
        IpAddr::V4(_) => 32,
        IpAddr::V6(_) => 128,
    }
}

fn in_cidr(address: IpAddr, network: IpAddr, prefix: u8) -> bool {
    match (address, network) {
        (IpAddr::V4(address), IpAddr::V4(network)) => {
            masked_v4(address, prefix) == masked_v4(network, prefix)
        }
        (IpAddr::V6(address), IpAddr::V6(network)) => {
            masked_v6(address, prefix) == masked_v6(network, prefix)
        }
        _ => false,
    }
}

fn masked_v4(address: Ipv4Addr, prefix: u8) -> u32 {
    let mask = u32::MAX.checked_shl(u32::from(32 - prefix)).unwrap_or(0);
    u32::from(address) & mask
}

fn masked_v6(address: Ipv6Addr, prefix: u8) -> u128 {
    let mask = u128::MAX.checked_shl(u32::from(128 - prefix)).unwrap_or(0);
    u128::from(address) & mask
}

fn invalid() -> PlatformError {
    PlatformError::new(
        ErrorCode::ConfigInvalid,
        "operator proxy environment is invalid or unsupported",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn policy_is_closed_prioritized_and_loopback_safe() {
        let values = HashMap::from([
            ("HTTPS_PROXY", "http://proxy.example:8080"),
            ("ALL_PROXY", "http://ignored.example:9000"),
            ("NO_PROXY", ".example.com,10.0.0.0/8,2001:db8::/32"),
        ]);
        let policy = OperatorProxyPolicy::from_lookup(|name| {
            values.get(name).map(|value| (*value).to_owned())
        })
        .unwrap();
        assert_eq!(policy.proxy().unwrap().source_variable(), "HTTPS_PROXY");
        for direct in [
            "http://127.0.0.1:1/",
            "http://localhost:1/",
            "https://api.example.com/",
            "https://10.2.3.4/",
            "https://[2001:db8::1]/",
        ] {
            assert_eq!(
                policy.decision(&Url::parse(direct).unwrap()).unwrap(),
                OperatorProxyDecision::Direct
            );
        }
        assert_eq!(
            policy
                .decision(&Url::parse("https://api.openai.com/").unwrap())
                .unwrap(),
            OperatorProxyDecision::Proxy
        );
        let http_only = HashMap::from([("HTTP_PROXY", "http://fallback.example:8080")]);
        assert_eq!(
            OperatorProxyPolicy::from_lookup(|name| {
                http_only.get(name).map(|value| (*value).to_owned())
            })
            .unwrap()
            .proxy()
            .unwrap()
            .source_variable(),
            "HTTP_PROXY"
        );
        for invalid in [
            "https://proxy.example:443",
            "http://u:p@proxy.example:80",
            "socks5://proxy.example:1080",
        ] {
            let values = HashMap::from([("HTTPS_PROXY", invalid)]);
            assert!(
                OperatorProxyPolicy::from_lookup(|name| values
                    .get(name)
                    .map(|value| (*value).to_owned()))
                .is_err()
            );
        }
    }
}
