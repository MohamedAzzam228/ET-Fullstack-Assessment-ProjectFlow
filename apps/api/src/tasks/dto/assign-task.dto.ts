import { IsMongoId, IsOptional, ValidateIf } from 'class-validator';

export class AssignTaskDto {
  /**
   * The user to assign. Pass null (or omit) to unassign.
   */
  @IsOptional()
  @ValidateIf((_obj, value) => value !== null && value !== undefined)
  @IsMongoId()
  assigneeId?: string | null;
}
