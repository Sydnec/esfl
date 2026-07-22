'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PublicUser } from '@esfl/contracts';
import { Avatar } from '@/components/Avatar';
import { useAuth } from '@/components/AuthProvider';
import { API_URL, ApiError } from '@/lib/api';
import styles from './page.module.css';

export default function ProfilePage() {
  const { user, loading, accessToken, authedFetch, applyUser, clearSession } = useAuth();
  const router = useRouter();

  const [username, setUsername] = useState('');
  const [usernameMessage, setUsernameMessage] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [avatarMessage, setAvatarMessage] = useState<string | null>(null);
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);

  useEffect(() => {
    if (user) setUsername(user.username);
  }, [user]);

  if (loading || !user) {
    return <main className={styles.main}>Chargement…</main>;
  }

  async function saveUsername(event: React.FormEvent) {
    event.preventDefault();
    setUsernameMessage(null);
    try {
      const updated = await authedFetch<PublicUser>('/auth/me', {
        method: 'PUT',
        body: JSON.stringify({ username }),
      });
      applyUser(updated);
      setUsernameMessage('Pseudo mis à jour ✓');
    } catch (err) {
      setUsernameMessage(err instanceof ApiError ? err.message : 'Échec de la mise à jour');
    }
  }

  async function savePassword(event: React.FormEvent) {
    event.preventDefault();
    setPasswordMessage(null);
    try {
      await authedFetch('/auth/me/password', {
        method: 'PUT',
        body: JSON.stringify({
          currentPassword: currentPassword || undefined,
          newPassword,
        }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setPasswordMessage('Mot de passe changé ✓');
    } catch (err) {
      setPasswordMessage(err instanceof ApiError ? err.message : 'Échec du changement');
    }
  }

  async function uploadAvatar(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setAvatarMessage(null);
    const body = new FormData();
    body.append('file', file);
    try {
      // FormData : pas de Content-Type manuel (boundary géré par le navigateur).
      const response = await fetch(`${API_URL}/auth/me/avatar`, {
        method: 'POST',
        credentials: 'include',
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
        body,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(payload.message ?? `Erreur ${response.status}`);
      }
      applyUser((await response.json()) as PublicUser);
      setAvatarVersion((v) => v + 1);
      setAvatarMessage('Avatar mis à jour ✓');
    } catch (err) {
      setAvatarMessage(err instanceof Error ? err.message : 'Échec de l’envoi');
    }
  }

  async function deleteAccount() {
    setDeleting(true);
    try {
      await authedFetch('/auth/me', { method: 'DELETE' });
      clearSession();
      router.push('/');
    } catch (err) {
      setDeleting(false);
      setConfirmDelete(false);
      setAvatarMessage(err instanceof ApiError ? err.message : 'Suppression impossible');
    }
  }

  return (
    <main className={styles.main}>
      <h1 className={styles.title}>Mon profil</h1>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Image de profil</h2>
        <div className={styles.avatarRow}>
          <Avatar
            src={user.avatarUrl ? `${API_URL}${user.avatarUrl}?v=${avatarVersion}` : null}
            label={user.username}
            size={64}
            fit="cover"
          />
          <label className={styles.uploadButton}>
            Choisir une image
            <input
              type="file"
              accept="image/*"
              onChange={(e) => void uploadAvatar(e)}
              className={styles.fileInput}
            />
          </label>
        </div>
        <p className={styles.hint}>Image de 2 Mo maximum.</p>
        {avatarMessage && <p className={styles.message}>{avatarMessage}</p>}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Pseudo affiché</h2>
        <form className={styles.inlineForm} onSubmit={saveUsername}>
          <input
            className={styles.input}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            minLength={3}
            maxLength={20}
            required
          />
          <button className={styles.submit} type="submit" disabled={username === user.username}>
            Enregistrer
          </button>
        </form>
        {usernameMessage && <p className={styles.message}>{usernameMessage}</p>}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Mot de passe</h2>
        <form className={styles.form} onSubmit={savePassword}>
          <label className={styles.label}>
            Mot de passe actuel (laisser vide si compte Discord/Google sans mot de passe)
            <input
              className={styles.input}
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          <label className={styles.label}>
            Nouveau mot de passe (8 caractères minimum)
            <input
              className={styles.input}
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={8}
              required
              autoComplete="new-password"
            />
          </label>
          <button className={styles.submit} type="submit">
            Changer le mot de passe
          </button>
        </form>
        {passwordMessage && <p className={styles.message}>{passwordMessage}</p>}
      </section>

      <section className={`${styles.section} ${styles.danger}`}>
        <h2 className={styles.sectionTitle}>Supprimer mon compte</h2>
        <p className={styles.hint}>
          Tes rosters et participations seront supprimés. Les ligues que tu as créées seront
          transférées à leur plus ancien membre (ou supprimées si tu y étais seul). Cette action est
          définitive.
        </p>
        {confirmDelete ? (
          <div className={styles.confirmRow}>
            <button
              className={styles.deleteButton}
              onClick={() => void deleteAccount()}
              disabled={deleting}
            >
              Confirmer la suppression définitive
            </button>
            <button className={styles.cancelButton} onClick={() => setConfirmDelete(false)}>
              Annuler
            </button>
          </div>
        ) : (
          <button className={styles.deleteButton} onClick={() => setConfirmDelete(true)}>
            Supprimer mon compte
          </button>
        )}
      </section>
    </main>
  );
}
