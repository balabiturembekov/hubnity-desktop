use reqwest::Client;
use std::time::Duration;

// Проверка online статуса через легковесный HTTP запрос
pub async fn check_online_status() -> bool {
    let client = match Client::builder().timeout(Duration::from_secs(2)).build() {
        Ok(client) => client,
        Err(_) => return false,
    };

    match client
        .get("https://www.cloudflare.com/cdn-cgi/trace")
        .timeout(Duration::from_secs(2))
        .send()
        .await
    {
        Ok(response) => response.status().is_success(),
        Err(_) => {
            match client
                .get("https://www.google.com/generate_204")
                .timeout(Duration::from_secs(2))
                .send()
                .await
            {
                Ok(response) => response.status().is_success() || response.status().as_u16() == 204,
                Err(_) => false,
            }
        }
    }
}

pub fn extract_url_from_title(title: &str) -> (Option<String>, Option<String>) {
    if let Some(url_start) = title.find("http://") {
        if let Some(url_end) = title[url_start..].find(' ') {
            let url = title[url_start..url_start + url_end].to_string();
            let domain = extract_domain(&url);
            return (Some(url), domain);
        } else {
            let url = title[url_start..].to_string();
            let domain = extract_domain(&url);
            return (Some(url), domain);
        }
    }

    if let Some(url_start) = title.find("https://") {
        if let Some(url_end) = title[url_start..].find(' ') {
            let url = title[url_start..url_start + url_end].to_string();
            let domain = extract_domain(&url);
            return (Some(url), domain);
        } else {
            let url = title[url_start..].to_string();
            let domain = extract_domain(&url);
            return (Some(url), domain);
        }
    }

    if title.contains('.') && !title.contains(' ') {
        return (None, Some(title.to_string()));
    }

    (None, None)
}

pub fn extract_domain(url: &str) -> Option<String> {
    if url.starts_with("http://") {
        let without_protocol = &url[7..];
        if let Some(slash_pos) = without_protocol.find('/') {
            return Some(without_protocol[..slash_pos].to_string());
        }
        return Some(without_protocol.to_string());
    }

    if url.starts_with("https://") {
        let without_protocol = &url[8..];
        if let Some(slash_pos) = without_protocol.find('/') {
            return Some(without_protocol[..slash_pos].to_string());
        }
        return Some(without_protocol.to_string());
    }

    None
}
