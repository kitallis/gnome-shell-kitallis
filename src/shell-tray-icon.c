/* -*- mode: C; c-file-style: "gnu"; indent-tabs-mode: nil; -*- */

#include "config.h"

#include "shell-tray-icon.h"
#include "shell-gtk-embed.h"
#include "shell-window-tracker.h"
#include "gtk-compat.h"
#include "tray/na-tray-child.h"
#include <gdk/gdkx.h>
#include "st.h"

enum {
   PROP_0,

   PROP_PID,
   PROP_TITLE,
   PROP_WM_CLASS
};

struct _ShellTrayIconPrivate
{
  NaTrayChild *socket;

  pid_t pid;
  char *title, *wm_class;
};

G_DEFINE_TYPE (ShellTrayIcon, shell_tray_icon, SHELL_TYPE_GTK_EMBED);

static void
shell_tray_icon_finalize (GObject *object)
{
  ShellTrayIcon *icon = SHELL_TRAY_ICON (object);

  g_free (icon->priv->title);
  g_free (icon->priv->wm_class);

  G_OBJECT_CLASS (shell_tray_icon_parent_class)->finalize (object);
}

static void
shell_tray_icon_constructed (GObject *object)
{
  GdkWindow *icon_app_window;
  ShellTrayIcon *icon = SHELL_TRAY_ICON (object);
  ShellEmbeddedWindow *window;
  GdkDisplay *display;
  Window plug_xid;
  Atom _NET_WM_PID, type;
  int result, format;
  gulong nitems, bytes_after, *val = NULL;

  /* We do all this now rather than computing it on the fly later,
   * because the shell may want to see their values from a
   * tray-icon-removed signal handler, at which point the plug has
   * already been removed from the socket.
   */

  g_object_get (object, "window", &window, NULL);
  g_return_if_fail (window != NULL);
  icon->priv->socket = NA_TRAY_CHILD (gtk_bin_get_child (GTK_BIN (window)));
  g_object_unref (window);

  icon->priv->title = na_tray_child_get_title (icon->priv->socket);
  na_tray_child_get_wm_class (icon->priv->socket, NULL, &icon->priv->wm_class);

  icon_app_window = gtk_socket_get_plug_window (GTK_SOCKET (icon->priv->socket));
  plug_xid = GDK_WINDOW_XID (icon_app_window);

  display = gtk_widget_get_display (GTK_WIDGET (icon->priv->socket));
  gdk_error_trap_push ();
  _NET_WM_PID = gdk_x11_get_xatom_by_name_for_display (display, "_NET_WM_PID");
  result = XGetWindowProperty (GDK_DISPLAY_XDISPLAY (display), plug_xid,
                               _NET_WM_PID, 0, G_MAXLONG, False, XA_CARDINAL,
                               &type, &format, &nitems,
                               &bytes_after, (guchar **)&val);
  if (!gdk_error_trap_pop () &&
      result == Success &&
      type == XA_CARDINAL &&
      nitems == 1)
    icon->priv->pid = *val;

  if (val)
    XFree (val);
}

static void
shell_tray_icon_get_property (GObject         *object,
                              guint            prop_id,
                              GValue          *value,
                              GParamSpec      *pspec)
{
  ShellTrayIcon *icon = SHELL_TRAY_ICON (object);

  switch (prop_id)
    {
    case PROP_PID:
      g_value_set_uint (value, icon->priv->pid);
      break;

    case PROP_TITLE:
      g_value_set_string (value, icon->priv->title);
      break;

    case PROP_WM_CLASS:
      g_value_set_string (value, icon->priv->wm_class);
      break;

    default:
      G_OBJECT_WARN_INVALID_PROPERTY_ID (object, prop_id, pspec);
      break;
    }
}

static void
shell_tray_icon_class_init (ShellTrayIconClass *klass)
{
  GObjectClass *object_class = G_OBJECT_CLASS (klass);

  g_type_class_add_private (klass, sizeof (ShellTrayIconPrivate));

  object_class->get_property = shell_tray_icon_get_property;
  object_class->constructed  = shell_tray_icon_constructed;
  object_class->finalize     = shell_tray_icon_finalize;

  g_object_class_install_property (object_class,
                                   PROP_PID,
                                   g_param_spec_uint ("pid",
                                                      "PID",
                                                      "The PID of the icon's application",
                                                      0, G_MAXUINT, 0,
                                                      G_PARAM_READABLE));
  g_object_class_install_property (object_class,
                                   PROP_TITLE,
                                   g_param_spec_string ("title",
                                                        "Title",
                                                        "The icon's window title",
                                                        NULL,
                                                        G_PARAM_READABLE));
  g_object_class_install_property (object_class,
                                   PROP_WM_CLASS,
                                   g_param_spec_string ("wm-class",
                                                        "WM Class",
                                                        "The icon's window WM_CLASS",
                                                        NULL,
                                                        G_PARAM_READABLE));
}

static void
shell_tray_icon_init (ShellTrayIcon *icon)
{
  icon->priv = G_TYPE_INSTANCE_GET_PRIVATE (icon, SHELL_TYPE_TRAY_ICON,
                                            ShellTrayIconPrivate);
}

/*
 * Public API
 */
ClutterActor *
shell_tray_icon_new (ShellEmbeddedWindow *window)
{
  g_return_val_if_fail (SHELL_IS_EMBEDDED_WINDOW (window), NULL);

  return g_object_new (SHELL_TYPE_TRAY_ICON,
                       "window", window,
                       NULL);
}