#
# luci-app-kidtime — per-device internet time control for OpenWrt 23.05
#
include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-kidtime
PKG_VERSION:=1.0
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0-or-later
PKG_MAINTAINER:=you

LUCI_TITLE:=Internet time control for kids (windows + daily activity budget)
LUCI_DEPENDS:=+luci-base +nftables +kmod-nft-core +dnsmasq
LUCI_PKGARCH:=all

# On 23.05 the luci.mk build flow produces a normal .ipk
include $(TOPDIR)/feeds/luci/luci.mk

# Fallback if not building inside the luci feed: define a plain package.
# (When using the luci feed, the block below is ignored.)

call BuildPackage,$(PKG_NAME)
