import { ConnectorStore } from "../adapters/store/connector-store.js";
import type {
  ConnectorProfile,
  ConnectorProfileCreateInput,
  ConnectorProfileUpdateInput,
  ConnectorVendor,
  BindableVendor,
  ProjectSpace,
  ProjectSpaceCreateInput,
  ProjectSpaceUpdateInput,
  ExternalLink,
  ExternalLinkCreateInput,
  ExternalLinkUpdateInput,
  ActivityEvent,
  ActivityEventCreateInput,
  EventStatus,
  EventStatusFilter,
  HealthCheckResult,
} from "../contracts/connectors.js";

/**
 * ConnectorHub (连接中心) application service.
 *
 * A thin orchestration layer over {@link ConnectorStore} that the HTTP routes
 * read from — mirroring the store+service+route+serve-wiring layering the other
 * subsystems use (e.g. {@link ScheduleService} over its file store). The store
 * already owns the secret-masking / merge-mask discipline, default promotion,
 * cascade deletes, and the LIGHTWEIGHT health check (real connectivity is
 * delegated to the corresponding MCP), so the service simply delegates each
 * operation and re-exposes the persisted, masked results.
 */
export class ConnectorService {
  private readonly store: ConnectorStore;

  constructor(options: { store: ConnectorStore }) {
    this.store = options.store;
  }

  /* ----------------------------------------------------------------------- *
   * Profiles
   * ----------------------------------------------------------------------- */

  /** All credential profiles (secrets masked), optionally filtered to one vendor. */
  listProfiles(vendor?: ConnectorVendor): Promise<ConnectorProfile[]> {
    return this.store.listProfiles(vendor);
  }

  /** A single profile by id (secrets masked), or undefined when absent. */
  getProfile(id: string): Promise<ConnectorProfile | undefined> {
    return this.store.getProfile(id);
  }

  /** Create a credential profile (secrets masked in the response). */
  createProfile(input: ConnectorProfileCreateInput): Promise<ConnectorProfile> {
    return this.store.createProfile(input);
  }

  /** Patch a profile, merge-masking echoed secrets. Throws "not found" on unknown id. */
  updateProfile(id: string, patch: ConnectorProfileUpdateInput): Promise<ConnectorProfile> {
    return this.store.updateProfile(id, patch);
  }

  /** Delete a profile (clears bindings + promotes the next default). Throws on unknown id. */
  deleteProfile(id: string): Promise<ConnectorProfile> {
    return this.store.deleteProfile(id);
  }

  /** Promote a profile to its vendor's default. Throws on unknown id / vendor mismatch. */
  setDefaultProfile(vendor: ConnectorVendor, id: string): Promise<ConnectorProfile> {
    return this.store.setDefaultProfile(vendor, id);
  }

  /**
   * LIGHTWEIGHT health check ("检测"): required-fields-present + URL well-formed
   * only, run against the STORED (unmasked) credentials. Real connectivity is
   * delegated to the corresponding MCP. Throws on unknown id.
   */
  checkProfile(id: string): Promise<HealthCheckResult> {
    return this.store.checkProfile(id);
  }

  /* ----------------------------------------------------------------------- *
   * Spaces
   * ----------------------------------------------------------------------- */

  /** All project spaces. */
  listSpaces(): Promise<ProjectSpace[]> {
    return this.store.listSpaces();
  }

  /** A single project space by id, or undefined when absent. */
  getSpace(id: string): Promise<ProjectSpace | undefined> {
    return this.store.getSpace(id);
  }

  /** Create a project space. */
  createSpace(input: ProjectSpaceCreateInput): Promise<ProjectSpace> {
    return this.store.createSpace(input);
  }

  /** Patch a project space. Throws on unknown id. */
  updateSpace(id: string, patch: ProjectSpaceUpdateInput): Promise<ProjectSpace> {
    return this.store.updateSpace(id, patch);
  }

  /** Delete a space (cascade-deletes its links + events). Throws on unknown id. */
  deleteSpace(id: string): Promise<ProjectSpace> {
    return this.store.deleteSpace(id);
  }

  /** Bind a space to a credential profile for one bindable vendor. Throws on validation failure. */
  bindProfile(spaceId: string, vendor: BindableVendor, profileId: string): Promise<ProjectSpace> {
    return this.store.bindProfile(spaceId, vendor, profileId);
  }

  /** Remove a space's binding for one bindable vendor. Throws on unknown space. */
  unbindProfile(spaceId: string, vendor: BindableVendor): Promise<ProjectSpace> {
    return this.store.unbindProfile(spaceId, vendor);
  }

  /* ----------------------------------------------------------------------- *
   * Links
   * ----------------------------------------------------------------------- */

  /** External resource links, optionally filtered to one space. */
  listLinks(spaceId?: string): Promise<ExternalLink[]> {
    return this.store.listLinks(spaceId);
  }

  /** Create a resource link (ref defaults to the kind's empty payload). Throws on unknown space. */
  createLink(input: ExternalLinkCreateInput): Promise<ExternalLink> {
    return this.store.createLink(input);
  }

  /** Patch a resource link. Throws on unknown id. */
  updateLink(id: string, patch: ExternalLinkUpdateInput): Promise<ExternalLink> {
    return this.store.updateLink(id, patch);
  }

  /** Delete a resource link. Throws on unknown id. */
  deleteLink(id: string): Promise<ExternalLink> {
    return this.store.deleteLink(id);
  }

  /* ----------------------------------------------------------------------- *
   * Events
   * ----------------------------------------------------------------------- */

  /** Activity events (newest first), filterable by space and/or status (`all` = no filter). */
  listEvents(filter?: { spaceId?: string; status?: EventStatusFilter }): Promise<ActivityEvent[]> {
    return this.store.listEvents(filter);
  }

  /** Append an activity event (the log is trimmed to its retention cap). */
  createEvent(input: ActivityEventCreateInput): Promise<ActivityEvent> {
    return this.store.createEvent(input);
  }

  /** Transition an event's status. Throws on unknown id. */
  setEventStatus(id: string, status: EventStatus): Promise<ActivityEvent> {
    return this.store.setEventStatus(id, status);
  }
}
